import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { getV2Client, getV2Db } from "../../db/v2/client.ts";
import {
  jobs,
  mutationReceipts,
  questionFlags,
  questions,
} from "../../db/v2/schema.ts";
import {
  MAX_QUESTION_BATCH,
  normalizeQuestionInput,
  type LeanQuestionInput,
  type NormalizedQuestionInput,
} from "./questionInput.ts";
import {
  assessQuestionQuality,
  type QuestionQualityAssessment,
} from "./questionQuality.ts";
import { rankQuestionIdsLexically } from "./questionSearch.ts";
import { normalizeReviewFlagInput } from "./reviewFlag.ts";
import type {
  V2LibraryResponse,
  V2QuestionFlag,
  V2QuestionLifecycle,
  V2Question,
} from "./types.ts";
import { evaluateRecall } from "./model.ts";
import { runLiveEvaluationJob } from "./liveReview.ts";
import { runQuestionEmbeddingJob } from "./questionEmbeddings.ts";

const QUESTION_PAGE_LIMIT = 100;

type V2Tx = Parameters<
  Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]
>[0];

export type AddQuestionResult = {
  id: string;
  status: "created" | "existing";
  outcome:
    | "created_active"
    | "created_flagged"
    | "idempotent_replay"
    | "exact_duplicate";
  lifecycle: V2QuestionLifecycle;
  flags: Array<Pick<V2QuestionFlag, "origin" | "reasons">>;
  answerStandardConflict: boolean;
};

type QuestionValidationInput = {
  prompt: string;
  referenceAnswer: string;
  target: string;
};

export type V2ServiceDependencies = {
  now(): Date;
  validateQuestion(
    input: QuestionValidationInput,
  ): QuestionQualityAssessment | Promise<QuestionQualityAssessment>;
  evaluateAnswer: typeof evaluateRecall;
};

export const defaultV2ServiceDependencies: V2ServiceDependencies = {
  now: () => new Date(),
  validateQuestion: assessQuestionQuality,
  evaluateAnswer: evaluateRecall,
};

const MACHINE_REASON_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;

function normalizedValidationAssessment(
  assessment: QuestionQualityAssessment,
): QuestionQualityAssessment {
  if (assessment.outcome === "pass") {
    return { outcome: "pass", reasons: [] };
  }
  const reasons = [
    ...new Set(
      assessment.reasons.filter((reason) => MACHINE_REASON_PATTERN.test(reason)),
    ),
  ];
  if (reasons.length > 0) return { outcome: assessment.outcome, reasons };
  return {
    outcome: assessment.outcome,
    reasons: [
      assessment.outcome === "fail"
        ? "semantic_quality_failed"
        : assessment.outcome === "inconclusive"
          ? "semantic_validation_inconclusive"
          : "semantic_validation_unavailable",
    ],
  };
}

async function validateQuestionCandidate(
  item: NormalizedQuestionInput,
  dependencies: V2ServiceDependencies,
): Promise<QuestionQualityAssessment> {
  try {
    return normalizedValidationAssessment(
      await dependencies.validateQuestion({
        prompt: item.prompt,
        referenceAnswer: item.referenceAnswer,
        target: item.prompt,
      }),
    );
  } catch {
    return {
      outcome: "unavailable",
      reasons: ["semantic_validation_unavailable"],
    };
  }
}

async function resolveQuestionFlags(
  tx: V2Tx,
  userId: string,
  questionId: string,
  resolvedAt: Date,
): Promise<void> {
  await tx
    .update(questionFlags)
    .set({ resolvedAt })
    .where(
      and(
        eq(questionFlags.userId, userId),
        eq(questionFlags.questionId, questionId),
        sql`${questionFlags.resolvedAt} IS NULL`,
      ),
    );
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function findReceipt<T>(
  userId: string,
  scope: string,
  key: string,
  requestHash: string,
): Promise<T | null> {
  const [row] = await getV2Db()
    .select({
      requestHash: mutationReceipts.requestHash,
      response: mutationReceipts.response,
    })
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.userId, userId),
        eq(mutationReceipts.scope, scope),
        eq(mutationReceipts.key, key),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    throw new Error("This idempotency key was already used for different input.");
  }
  return row.response as T;
}

function normalizedRequestHash(items: NormalizedQuestionInput[]): string {
  return checksum(JSON.stringify(items));
}

function idempotentReplayResult(
  result: AddQuestionResult,
): AddQuestionResult {
  return {
    ...result,
    status: "existing",
    outcome: "idempotent_replay",
  };
}

export async function addQuestions(
  input: {
    userId: string;
    idempotencyKey: string;
    items: LeanQuestionInput[];
    scope?: "library" | "mcp";
  },
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<{
  results: AddQuestionResult[];
}> {
  if (input.items.length === 0 || input.items.length > MAX_QUESTION_BATCH) {
    throw new Error(`Add between 1 and ${MAX_QUESTION_BATCH} questions at a time.`);
  }
  const items = input.items.map((item) => normalizeQuestionInput(item));
  const scope = input.scope === "mcp" ? "mcp-add-questions" : "library-add-questions";
  const key = input.idempotencyKey.trim().slice(0, 200);
  if (!key) throw new Error("An idempotency key is required.");
  const requestHash = normalizedRequestHash(items);
  const prior = await findReceipt<{ results: AddQuestionResult[] }>(
    input.userId,
    scope,
    key,
    requestHash,
  );
  if (prior) {
    return {
      results: prior.results.map(idempotentReplayResult),
    };
  }
  const assessments = await Promise.all(
    items.map((item) => validateQuestionCandidate(item, dependencies)),
  );

  return await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
    );
    const [receipt] = await tx
      .select({
        requestHash: mutationReceipts.requestHash,
        response: mutationReceipts.response,
      })
      .from(mutationReceipts)
      .where(
        and(
          eq(mutationReceipts.userId, input.userId),
          eq(mutationReceipts.scope, scope),
          eq(mutationReceipts.key, key),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new Error("This idempotency key was already used for different input.");
      }
      const response = receipt.response as { results: AddQuestionResult[] };
      return {
        results: response.results.map(idempotentReplayResult),
      };
    }

    const requestedPromptKeys = [...new Set(items.map((item) => item.promptKey))];
    const existing = await tx
      .select({
        id: questions.id,
        lifecycle: questions.lifecycle,
        targetKey: questions.targetKey,
        referenceAnswer: questions.referenceAnswer,
      })
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          inArray(questions.targetKey, requestedPromptKeys),
        ),
      );
    const byPromptKey = new Map<string, (typeof existing)[number]>();
    for (const candidate of existing) {
      const retained = byPromptKey.get(candidate.targetKey);
      if (!retained || candidate.lifecycle === "active") {
        byPromptKey.set(candidate.targetKey, candidate);
      }
    }
    const existingFlags = existing.length > 0
      ? await tx
          .select({
            questionId: questionFlags.questionId,
            origin: questionFlags.origin,
            reasons: questionFlags.reasons,
          })
          .from(questionFlags)
          .where(
            and(
              eq(questionFlags.userId, input.userId),
              inArray(
                questionFlags.questionId,
                existing.map((question) => question.id),
              ),
              sql`${questionFlags.resolvedAt} IS NULL`,
            ),
          )
      : [];
    const flagsByQuestionId = new Map<
      string,
      Array<Pick<V2QuestionFlag, "origin" | "reasons">>
    >();
    for (const flag of existingFlags) {
      const retained = flagsByQuestionId.get(flag.questionId) ?? [];
      retained.push({ origin: flag.origin, reasons: flag.reasons });
      flagsByQuestionId.set(flag.questionId, retained);
    }
    const [{ questionCount }] = await tx
      .select({ questionCount: count() })
      .from(questions)
      .where(eq(questions.userId, input.userId));
    const uniqueNewCount = new Set(
      items
        .map((item) => item.promptKey)
        .filter((key) => !byPromptKey.has(key)),
    ).size;
    if (questionCount + uniqueNewCount > 100_000) {
      throw new Error("Your question-bank limit is full.");
    }
    const results: AddQuestionResult[] = [];
    const createdQuestionIds: string[] = [];

    for (const [index, item] of items.entries()) {
      const assessment = assessments[index] ?? {
        outcome: "unavailable" as const,
        reasons: ["semantic_validation_unavailable"],
      };
      const duplicate = byPromptKey.get(item.promptKey);
      if (duplicate) {
        results.push({
          id: duplicate.id,
          status: "existing",
          outcome: "exact_duplicate",
          lifecycle: duplicate.lifecycle,
          flags: flagsByQuestionId.get(duplicate.id) ?? [],
          answerStandardConflict:
            duplicate.referenceAnswer.trim() !== item.referenceAnswer,
        });
        continue;
      }
      const flag = assessment.outcome === "pass"
        ? null
        : {
            origin: "waxon_validation" as const,
            reasons: assessment.reasons,
          };
      const [question] = await tx
        .insert(questions)
        .values({
          userId: input.userId,
          prompt: item.prompt,
          referenceAnswer: item.referenceAnswer,
          lifecycle: flag ? "flagged" : "active",
          targetKey: item.promptKey,
        })
        .returning({ id: questions.id });
      if (flag) {
        await tx.insert(questionFlags).values({
          userId: input.userId,
          questionId: question.id,
          ...flag,
        });
      }
      const created: AddQuestionResult = {
        id: question.id,
        status: "created",
        outcome: flag ? "created_flagged" : "created_active",
        lifecycle: flag ? "flagged" : "active",
        flags: flag ? [flag] : [],
        answerStandardConflict: false,
      };
      results.push(created);
      createdQuestionIds.push(question.id);
      byPromptKey.set(item.promptKey, {
        id: question.id,
        lifecycle: flag ? "flagged" : "active",
        targetKey: item.promptKey,
        referenceAnswer: item.referenceAnswer,
      });
      flagsByQuestionId.set(question.id, created.flags);
    }

    if (createdQuestionIds.length > 0) {
      await tx.insert(jobs).values({
        userId: input.userId,
        type: "embed_question_batch",
        idempotencyKey: `question-search-v1:${scope}:${key}`,
        priority: 2,
        payload: { questionIds: createdQuestionIds },
      });
    }

    const response = { results };
    await tx.insert(mutationReceipts).values({
      userId: input.userId,
      scope,
      key,
      requestHash,
      response,
    });
    return response;
  });
}

export async function createDirectQuestion(
  input: {
    userId: string;
    idempotencyKey: string;
    prompt: string;
    referenceAnswer: string;
  },
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<{
  questionId: string;
  lifecycle: V2QuestionLifecycle;
  status: "created" | "existing";
  outcome: AddQuestionResult["outcome"];
  flags: Array<Pick<V2QuestionFlag, "origin" | "reasons">>;
  answerStandardConflict: boolean;
}> {
  const { results } = await addQuestions({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    items: [input],
  }, dependencies);
  const result = results[0];
  return {
    questionId: result.id,
    lifecycle: result.lifecycle,
    status: result.status,
    outcome: result.outcome,
    flags: result.flags,
    answerStandardConflict: result.answerStandardConflict,
  };
}

export async function listLibrary(input: {
  userId: string;
  search?: string;
  lifecycle?: V2QuestionLifecycle | "all";
  limit?: number;
}): Promise<V2LibraryResponse> {
  const limit = Math.max(1, Math.min(QUESTION_PAGE_LIMIT, input.limit ?? 100));
  const search = input.search?.trim() ?? "";
  const lifecycle =
    input.lifecycle && input.lifecycle !== "all" ? input.lifecycle : null;
  const pool = getV2Client().pool;
  const rankedIds = search
    ? await rankQuestionIdsLexically({
        userId: input.userId,
        query: search,
        lifecycle,
        limit,
      })
    : [];
  const rows = await pool.query<{
    id: string;
    prompt: string;
    reference_answer: string;
    lifecycle: string;
    due_at: Date | null;
    created_at: Date;
    updated_at: Date;
    flags: V2QuestionFlag[];
  }>(
    `SELECT q.id, q.prompt, q.reference_answer,
            q.lifecycle::text, ms.due_at, q.created_at, q.updated_at,
            COALESCE(
              (SELECT jsonb_agg(
                 jsonb_build_object(
                   'origin', flag.origin::text,
                   'reasons', flag.reasons,
                   'detail', flag.detail,
                   'createdAt', flag.created_at,
                   'resolvedAt', flag.resolved_at
                 ) ORDER BY flag.created_at, flag.id
               )
                 FROM waxon_v2.question_flags flag
                WHERE flag.user_id = q.user_id
                  AND flag.question_id = q.id),
              '[]'::jsonb
            ) AS flags
       FROM waxon_v2.questions q
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1
        AND (
          $2::text IS NULL
          OR q.lifecycle::text = $2
        )
        AND ($3 = '' OR q.id = ANY($5::uuid[]))
        AND q.lifecycle::text IN ('active','flagged','archived')
      ORDER BY CASE WHEN $3 <> '' THEN array_position($5::uuid[], q.id) END,
               q.updated_at DESC, q.id
      LIMIT $4`,
    [input.userId, lifecycle, search, limit, rankedIds],
  );
  const questionsOut: V2Question[] = rows.rows.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      referenceAnswer: row.reference_answer,
      lifecycle: row.lifecycle as V2QuestionLifecycle,
      flags: row.flags,
      dueAt: row.due_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  const countRows = await pool.query<{ lifecycle: string; count: string }>(
    `SELECT lifecycle::text, count(*)::text
       FROM waxon_v2.questions
      WHERE user_id = $1
        AND lifecycle::text IN ('active','flagged','archived')
      GROUP BY lifecycle`,
    [input.userId],
  );
  const counts: Record<V2QuestionLifecycle, number> = {
    active: 0,
    flagged: 0,
    archived: 0,
  };
  for (const row of countRows.rows) {
    if (row.lifecycle === "active" || row.lifecycle === "flagged" || row.lifecycle === "archived") {
      counts[row.lifecycle] += Number(row.count);
    }
  }
  return { questions: questionsOut, counts };
}

export async function getQuestionLearningEvidence(input: {
  userId: string;
  questionId: string;
}): Promise<{
  learnerAnswers: number;
  evaluations: number;
  gradeEvents: number;
  dueAt: string | null;
}> {
  const [row] = await getV2Client().pool
    .query<{
      learner_answers: string;
      evaluations: string;
      grade_events: string;
      due_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM waxon_v2.answer_submissions submission
           WHERE submission.user_id = question.user_id
             AND submission.question_id = question.id) AS learner_answers,
         (SELECT count(*)::text
            FROM waxon_v2.evaluations evaluation
            JOIN waxon_v2.answer_submissions submission
              ON submission.user_id = evaluation.user_id
             AND submission.id = evaluation.submission_id
           WHERE submission.user_id = question.user_id
             AND submission.question_id = question.id) AS evaluations,
         (SELECT count(*)::text
            FROM waxon_v2.grade_events event
            JOIN waxon_v2.answer_submissions submission
              ON submission.user_id = event.user_id
             AND submission.id = event.submission_id
           WHERE submission.user_id = question.user_id
             AND submission.question_id = question.id) AS grade_events,
         memory.due_at
       FROM waxon_v2.questions question
       LEFT JOIN waxon_v2.memory_states memory
         ON memory.user_id = question.user_id
        AND memory.question_id = question.id
      WHERE question.user_id = $1 AND question.id = $2
      LIMIT 1`,
      [input.userId, input.questionId],
    )
    .then((result) => result.rows);
  if (!row) throw new Error("Question not found.");
  return {
    learnerAnswers: Number(row.learner_answers),
    evaluations: Number(row.evaluations),
    gradeEvents: Number(row.grade_events),
    dueAt: row.due_at?.toISOString() ?? null,
  };
}

export async function mutateQuestionLifecycle(input: {
  userId: string;
  questionId: string;
  action: "archive" | "restore";
}, dependencies: V2ServiceDependencies = defaultV2ServiceDependencies): Promise<void> {
  const db = getV2Db();
  const now = dependencies.now();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
    );
    const [question] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)))
      .limit(1);
    if (!question) throw new Error("Question not found.");
    if (
      input.action === "restore" &&
      question.lifecycle !== "active"
    ) {
      const [duplicate] = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.userId, input.userId),
            eq(questions.targetKey, question.targetKey),
            ne(questions.id, question.id),
            eq(questions.lifecycle, "active"),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new Error("Another Active Question already uses this prompt.");
      }
    }
    const next: V2QuestionLifecycle =
      input.action === "archive" ? "archived" : "active";
    await tx
      .update(questions)
      .set({
        lifecycle: next,
        updatedAt: now,
      })
      .where(
        and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)),
      );
    if (question.lifecycle === "flagged") {
      await resolveQuestionFlags(tx, input.userId, input.questionId, now);
    }
  });
}

export async function flagQuestionInBank(input: {
  userId: string;
  questionId: string;
  reasons?: unknown;
  detail?: unknown;
}, dependencies: Pick<V2ServiceDependencies, "now"> = defaultV2ServiceDependencies): Promise<{
  questionId: string;
  lifecycle: "flagged";
  flag: V2QuestionFlag;
}> {
  const questionId = input.questionId.trim();
  if (!questionId) throw new Error("A Question is required.");
  const normalized = normalizeReviewFlagInput(input);
  const now = dependencies.now();

  return getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))`,
    );
    const [question] = await tx
      .select({ lifecycle: questions.lifecycle })
      .from(questions)
      .where(
        and(eq(questions.userId, input.userId), eq(questions.id, questionId)),
      )
      .limit(1);
    if (!question) throw new Error("Question not found.");
    if (question.lifecycle !== "active") {
      throw new Error("This Question is no longer Active.");
    }

    await tx
      .update(questions)
      .set({ lifecycle: "flagged", updatedAt: now })
      .where(
        and(eq(questions.userId, input.userId), eq(questions.id, questionId)),
      );
    await tx.insert(questionFlags).values({
      userId: input.userId,
      questionId,
      origin: "learner",
      reasons: normalized.reasons,
      detail: normalized.detail,
      createdAt: now,
    });

    return {
      questionId,
      lifecycle: "flagged" as const,
      flag: {
        origin: "learner" as const,
        reasons: normalized.reasons,
        detail: normalized.detail,
        createdAt: now.toISOString(),
        resolvedAt: null,
      },
    };
  });
}

export async function replaceQuestion(input: {
  userId: string;
  questionId: string;
  prompt: string;
  referenceAnswer: string;
}, dependencies: V2ServiceDependencies = defaultV2ServiceDependencies): Promise<{
  questionId: string;
  archivedQuestionId: string | null;
  lifecycle: V2QuestionLifecycle;
  status: "replaced" | "unchanged";
}> {
  const now = dependencies.now();
  const normalized = normalizeQuestionInput(input);
  const assessment = await validateQuestionCandidate(normalized, dependencies);
  const validationFlag = assessment.outcome === "pass"
    ? null
    : {
        origin: "waxon_validation" as const,
        reasons: assessment.reasons,
      };
  return await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
    );
    const [current] = await tx
      .select({
        questionId: questions.id,
        lifecycle: questions.lifecycle,
        targetKey: questions.targetKey,
        prompt: questions.prompt,
        referenceAnswer: questions.referenceAnswer,
      })
      .from(questions)
      .where(
        and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)),
      )
      .limit(1);
    if (!current) throw new Error("Question not found.");
    if (
      normalized.promptKey === current.targetKey &&
      normalized.referenceAnswer === current.referenceAnswer
    ) {
      return {
        questionId: current.questionId,
        archivedQuestionId: null,
        lifecycle: current.lifecycle,
        status: "unchanged" as const,
      };
    }
    const [duplicate] = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.targetKey, normalized.promptKey),
          ne(questions.id, input.questionId),
          normalized.promptKey === current.targetKey
            ? ne(questions.lifecycle, "archived")
            : undefined,
        ),
      )
      .limit(1);
    if (duplicate) throw new Error("Another question already uses this prompt.");
    await tx
      .update(questions)
      .set({
        lifecycle: "archived",
        updatedAt: now,
      })
      .where(
        and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)),
      );
    await resolveQuestionFlags(tx, input.userId, input.questionId, now);
    const [replacement] = await tx
      .insert(questions)
      .values({
        userId: input.userId,
        prompt: normalized.prompt,
        referenceAnswer: normalized.referenceAnswer,
        lifecycle: validationFlag ? "flagged" : "active",
        targetKey: normalized.promptKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: questions.id });
    if (validationFlag) {
      await tx.insert(questionFlags).values({
        userId: input.userId,
        questionId: replacement.id,
        ...validationFlag,
        createdAt: now,
      });
    }
    await tx.insert(jobs).values({
      userId: input.userId,
      type: "embed_question_batch",
      idempotencyKey: `question-search-v1:${replacement.id}`,
      priority: 2,
      payload: { questionIds: [replacement.id] },
    });
    return {
      questionId: replacement.id,
      archivedQuestionId: current.questionId,
      lifecycle: validationFlag ? "flagged" as const : "active" as const,
      status: "replaced" as const,
    };
  });
}

export async function runPendingJobs(input: {
  userId?: string;
  limit?: number;
}): Promise<number> {
  const db = getV2Db();
  const pending = await db
    .select({ id: jobs.id, type: jobs.type })
    .from(jobs)
    .where(
      and(
        input.userId ? eq(jobs.userId, input.userId) : undefined,
        eq(jobs.status, "pending"),
        inArray(jobs.type, ["evaluate_submission", "embed_question_batch"]),
        lte(jobs.runAfter, new Date()),
      ),
    )
    .orderBy(asc(jobs.priority), asc(jobs.createdAt))
    .limit(Math.max(1, Math.min(20, input.limit ?? 5)));
  let processed = 0;
  for (const job of pending) {
    try {
      if (job.type === "evaluate_submission") {
        await runLiveEvaluationJob(job.id);
      } else if (job.type === "embed_question_batch") {
        await runQuestionEmbeddingJob(job.id);
      }
      processed += 1;
    } catch (error) {
      Sentry.captureException(error, {
        tags: { waxon_version: "lean", job_type: job.type },
        extra: { jobId: job.id },
      });
    }
  }
  return processed;
}
