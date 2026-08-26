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
  memoryStates,
  mutationReceipts,
  questionFlags,
  questionVersions,
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
import type {
  V2LibraryResponse,
  V2Lifecycle,
  V2QuestionFlag,
  V2QuestionLifecycle,
  V2Question,
} from "./types.ts";
import { evaluateRecall } from "./model.ts";
import { runLiveEvaluationJob } from "./liveReview.ts";
import { runQuestionEmbeddingJob } from "./questionEmbeddings.ts";

const ACTIVE_LIFECYCLES: V2Lifecycle[] = ["new", "learning", "review"];
const ALL_LIFECYCLES: V2Lifecycle[] = [
  "new",
  "learning",
  "review",
  "flagged",
  "paused",
  "archived",
  "trash",
];
const QUESTION_PAGE_LIMIT = 100;

type V2Tx = Parameters<
  Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]
>[0];

export type AddQuestionResult = {
  id: string;
  status: "created" | "existing";
  lifecycle: V2QuestionLifecycle;
  flags: Array<Pick<V2QuestionFlag, "origin" | "reasons">>;
};

function questionLifecycle(value: string): V2QuestionLifecycle {
  if (value === "active" || ACTIVE_LIFECYCLES.includes(value as V2Lifecycle)) {
    return "active";
  }
  return value === "flagged" ? "flagged" : "archived";
}

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
      results: prior.results.map((result) => ({
        ...result,
        lifecycle: questionLifecycle(result.lifecycle),
        flags: result.flags ?? [],
      })),
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
        results: response.results.map((result) => ({
          ...result,
          lifecycle: questionLifecycle(result.lifecycle),
          flags: result.flags ?? [],
        })),
      };
    }

    const requestedPromptKeys = [...new Set(items.map((item) => item.promptKey))];
    const existing = await tx
      .select({
        id: questions.id,
        lifecycle: questions.lifecycle,
        targetKey: questions.targetKey,
        referenceAnswer: questionVersions.referenceAnswer,
      })
      .from(questions)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.userId, questions.userId),
          eq(questionVersions.questionId, questions.id),
          eq(questionVersions.isCurrent, true),
        ),
      )
      .where(
        and(
          eq(questions.userId, input.userId),
          inArray(questions.targetKey, requestedPromptKeys),
        ),
      );
    const byPromptKey = new Map<string, (typeof existing)[number]>();
    for (const candidate of existing) {
      const retained = byPromptKey.get(candidate.targetKey);
      if (
        !retained ||
        (ACTIVE_LIFECYCLES.includes(candidate.lifecycle as V2Lifecycle) &&
          !ACTIVE_LIFECYCLES.includes(retained.lifecycle as V2Lifecycle))
      ) {
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
        if (duplicate.referenceAnswer.trim() !== item.referenceAnswer) {
          throw new Error(
            `“${item.prompt.slice(0, 120)}” already exists with a different Answer Standard. Replace the existing Question instead.`,
          );
        }
        results.push({
          id: duplicate.id,
          status: "existing",
          lifecycle: questionLifecycle(duplicate.lifecycle),
          flags: flagsByQuestionId.get(duplicate.id) ?? [],
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
          lifecycle: flag ? "flagged" : "new",
          targetKey: item.promptKey,
        })
        .returning({ id: questions.id });
      await tx.insert(questionVersions).values({
        userId: input.userId,
        questionId: question.id,
        version: 1,
        prompt: item.prompt,
        referenceAnswer: item.referenceAnswer,
        displayAnswer: item.referenceAnswer.slice(0, 8_000),
      });
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
        lifecycle: flag ? "flagged" : "active",
        flags: flag ? [flag] : [],
      };
      results.push(created);
      createdQuestionIds.push(question.id);
      byPromptKey.set(item.promptKey, {
        id: question.id,
        lifecycle: flag ? "flagged" : "new",
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
  flags: Array<Pick<V2QuestionFlag, "origin" | "reasons">>;
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
    flags: result.flags,
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
    version_id: string;
    prompt: string;
    reference_answer: string;
    lifecycle: string;
    due_at: Date | null;
    created_at: Date;
    updated_at: Date;
    flags: V2QuestionFlag[];
  }>(
    `SELECT q.id, qv.id AS version_id, qv.prompt, qv.reference_answer,
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
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id AND qv.question_id = q.id AND qv.is_current = true
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1
        AND (
          $2::text IS NULL
          OR ($2 = 'active' AND q.lifecycle::text IN ('new','learning','review'))
          OR ($2 = 'flagged' AND q.lifecycle::text = 'flagged')
          OR ($2 = 'archived' AND q.lifecycle::text IN ('paused','archived','trash'))
        )
        AND ($3 = '' OR q.id = ANY($5::uuid[]))
        AND q.lifecycle::text IN ('new','learning','review','flagged','paused','archived','trash')
      ORDER BY CASE WHEN $3 <> '' THEN array_position($5::uuid[], q.id) END,
               q.updated_at DESC, q.id
      LIMIT $4`,
    [input.userId, lifecycle, search, limit, rankedIds],
  );
  const questionsOut: V2Question[] = rows.rows.map((row) => ({
      id: row.id,
      versionId: row.version_id,
      prompt: row.prompt,
      referenceAnswer: row.reference_answer,
      lifecycle: questionLifecycle(row.lifecycle),
      flags: row.flags,
      dueAt: row.due_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  const countRows = await pool.query<{ lifecycle: string; count: string }>(
    `SELECT lifecycle::text, count(*)::text
       FROM waxon_v2.questions
      WHERE user_id = $1
        AND lifecycle::text IN ('new','learning','review','flagged','paused','archived','trash')
      GROUP BY lifecycle`,
    [input.userId],
  );
  const counts: Record<V2QuestionLifecycle, number> = {
    active: 0,
    flagged: 0,
    archived: 0,
  };
  for (const row of countRows.rows) {
    if (ALL_LIFECYCLES.includes(row.lifecycle as V2Lifecycle)) {
      counts[questionLifecycle(row.lifecycle)] += Number(row.count);
    }
  }
  const waitingNew = Number(
    countRows.rows.find((row) => row.lifecycle === "new")?.count ?? 0,
  );
  return { questions: questionsOut, counts, waitingNew };
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
      !ACTIVE_LIFECYCLES.includes(question.lifecycle as V2Lifecycle)
    ) {
      const [duplicate] = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.userId, input.userId),
            eq(questions.targetKey, question.targetKey),
            ne(questions.id, question.id),
            inArray(questions.lifecycle, ACTIVE_LIFECYCLES),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new Error("Another Active Question already uses this prompt.");
      }
    }
    let restoredLifecycle: V2Lifecycle = "new";
    if (input.action === "restore") {
      const currentLifecycle = question.lifecycle as V2Lifecycle;
      const priorLifecycle = question.priorLifecycle as V2Lifecycle | null;
      if (ACTIVE_LIFECYCLES.includes(currentLifecycle)) {
        restoredLifecycle = currentLifecycle;
      } else if (priorLifecycle && ACTIVE_LIFECYCLES.includes(priorLifecycle)) {
        restoredLifecycle = priorLifecycle;
      } else {
        const [memory] = await tx
          .select({ questionId: memoryStates.questionId })
          .from(memoryStates)
          .where(
            and(
              eq(memoryStates.userId, input.userId),
              eq(memoryStates.questionId, input.questionId),
            ),
          )
          .limit(1);
        restoredLifecycle = memory ? "review" : "new";
      }
    }
    const next: V2Lifecycle =
      input.action === "archive" ? "archived" : restoredLifecycle;
    await tx
      .update(questions)
      .set({
        lifecycle: next,
        priorLifecycle:
          input.action === "restore"
            ? null
            : ALL_LIFECYCLES.includes(question.lifecycle as V2Lifecycle)
              ? (question.lifecycle as V2Lifecycle)
              : null,
        suspensionReason: null,
        deletedAt: null,
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
  return await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
    );
    const [current] = await tx
      .select({
        questionId: questions.id,
        lifecycle: questions.lifecycle,
        targetKey: questions.targetKey,
        prompt: questionVersions.prompt,
        referenceAnswer: questionVersions.referenceAnswer,
      })
      .from(questions)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.userId, questions.userId),
          eq(questionVersions.questionId, questions.id),
          eq(questionVersions.isCurrent, true),
        ),
      )
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
        lifecycle: questionLifecycle(current.lifecycle),
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
            ? sql`${questions.lifecycle} NOT IN ('paused', 'archived', 'trash')`
            : undefined,
        ),
      )
      .limit(1);
    if (duplicate) throw new Error("Another question already uses this prompt.");
    await tx
      .update(questions)
      .set({
        lifecycle: "archived",
        priorLifecycle: current.lifecycle,
        suspensionReason: null,
        deletedAt: null,
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
        lifecycle: "new",
        targetKey: normalized.promptKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: questions.id });
    const [replacementVersion] = await tx
      .insert(questionVersions)
      .values({
        userId: input.userId,
        questionId: replacement.id,
        version: 1,
        prompt: normalized.prompt,
        referenceAnswer: normalized.referenceAnswer,
        displayAnswer: normalized.referenceAnswer.slice(0, 8_000),
      })
      .returning({ id: questionVersions.id });
    await tx.insert(jobs).values({
      userId: input.userId,
      type: "embed_question_batch",
      idempotencyKey: `question-search-v1:${replacement.id}:${replacementVersion.id}`,
      priority: 2,
      payload: { questionIds: [replacement.id] },
    });
    return {
      questionId: replacement.id,
      archivedQuestionId: current.questionId,
      lifecycle: "active" as const,
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
