import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getV2Client, getV2Db } from "@/app/db/v2/client";
import {
  answerSubmissions,
  conceptAliases,
  concepts,
  coverageTargets,
  evidenceSpans,
  evaluations,
  gradeEvents,
  jobs,
  learnerSettings,
  memoryStates,
  mutationReceipts,
  questionConcepts,
  questionEmbeddings,
  questionEvidence,
  questionRelations,
  questions,
  questionVersions,
  repairDrafts,
  retryObligations,
  reviewSessionItems,
  reviewSessions,
  sourceVersions,
  sources,
  targetQuestions,
} from "@/app/db/v2/schema";
import { vectorLiteral } from "@/shared/vector-literal.mts";
import { buildReviewPlan, type PlanCandidate } from "./planner";
import {
  assessQuestionQuality,
  normalizeExactAnswer,
  recallTargetKey,
} from "./questionQuality";
import {
  applyFsrsGrade,
  memoryRetrievability,
  SCHEDULER_VERSION,
  type StoredMemoryState,
} from "./scheduler";
import type {
  V2AnswerMode,
  V2Evaluation,
  V2Grade,
  V2LibraryResponse,
  V2Lifecycle,
  V2Question,
  V2ReviewItem,
  V2ReviewSessionResponse,
  V2ReviewSummary,
  V2Source,
} from "./types";
import {
  embedTexts,
  evaluateRecall,
  generateRepairQuestion,
} from "./model";
import { claimV2Job } from "./jobs";
import { retryEarliestAt } from "./retryPolicy";

const ACTIVE_LIFECYCLES: V2Lifecycle[] = ["new", "learning", "review"];
const QUESTION_PAGE_LIMIT = 100;

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function storedMemory(
  row:
    | {
        dueAt: Date;
        lastReviewAt: Date | null;
        stability: number;
        difficulty: number;
        elapsedDays: number;
        scheduledDays: number;
        reps: number;
        lapses: number;
        state: number;
        learningSteps: number;
      }
    | null
    | undefined,
): StoredMemoryState | null {
  return row
    ? {
        dueAt: row.dueAt,
        lastReviewAt: row.lastReviewAt,
        stability: row.stability,
        difficulty: row.difficulty,
        elapsedDays: row.elapsedDays,
        scheduledDays: row.scheduledDays,
        reps: row.reps,
        lapses: row.lapses,
        state: row.state,
        learningSteps: row.learningSteps,
      }
    : null;
}

export async function getLearnerSettings(userId: string) {
  const db = getV2Db();
  const [settings] = await db
    .insert(learnerSettings)
    .values({ userId })
    .onConflictDoNothing({ target: learnerSettings.userId })
    .returning();

  if (settings) {
    return settings;
  }

  const [existing] = await db
    .select()
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);

  if (!existing) {
    throw new Error("Could not load learner settings.");
  }

  return existing;
}

export async function updateLearnerSettings(input: {
  userId: string;
  dailyMinutes?: number;
  desiredRetention?: number;
  newItemsPerDay?: number;
  timezone?: string;
}) {
  const db = getV2Db();
  await getLearnerSettings(input.userId);
  const [row] = await db
    .update(learnerSettings)
    .set({
      dailyMinutes:
        input.dailyMinutes === undefined
          ? undefined
          : Math.max(1, Math.min(120, Math.round(input.dailyMinutes))),
      desiredRetention:
        input.desiredRetention === undefined
          ? undefined
          : Math.max(0.7, Math.min(0.97, input.desiredRetention)),
      newItemsPerDay:
        input.newItemsPerDay === undefined
          ? undefined
          : Math.max(0, Math.min(100, Math.round(input.newItemsPerDay))),
      timezone: input.timezone?.trim().slice(0, 100),
      updatedAt: new Date(),
    })
    .where(eq(learnerSettings.userId, input.userId))
    .returning();

  return row;
}

async function receiptResult<T>(
  userId: string,
  scope: string,
  key: string,
  requestHash: string,
): Promise<T | null> {
  const db = getV2Db();
  const [row] = await db
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

  if (!row) {
    return null;
  }
  if (row.requestHash !== requestHash) {
    throw new Error("This idempotency key was already used for different input.");
  }
  return row.response as T;
}

export async function createDirectQuestion(input: {
  userId: string;
  idempotencyKey: string;
  prompt: string;
  referenceAnswer: string;
  displayAnswer?: string;
  target?: string;
  answerMode: V2AnswerMode;
}): Promise<{ questionId: string; lifecycle: V2Lifecycle; jobId: string | null }> {
  const prompt = input.prompt.trim();
  const referenceAnswer = input.referenceAnswer.trim();
  const displayAnswer =
    input.displayAnswer?.trim() || referenceAnswer.slice(0, 8_000);
  const target = input.target?.trim() || prompt;
  const body = `${prompt}\n\n${referenceAnswer}`;
  const requestHash = checksum(
    JSON.stringify({
      prompt,
      referenceAnswer,
      displayAnswer,
      target,
      answerMode: input.answerMode,
    }),
  );
  const prior = await receiptResult<{
    questionId: string;
    lifecycle: V2Lifecycle;
    jobId: string | null;
  }>(input.userId, "direct-question", input.idempotencyKey, requestHash);

  if (prior) {
    return prior;
  }

  const quality = assessQuestionQuality({ prompt, referenceAnswer, target });
  const targetKey = recallTargetKey(target);
  const db = getV2Db();
  const [capacity] = await getV2Client().pool
    .query<{ question_count: string; pending_jobs: string }>(
      `SELECT
        (SELECT count(*) FROM waxon_v2.questions WHERE user_id = $1)::text AS question_count,
        (SELECT count(*) FROM waxon_v2.jobs
          WHERE user_id = $1 AND status IN ('pending','running'))::text AS pending_jobs`,
      [input.userId],
    )
    .then((result) => result.rows);
  if (Number(capacity?.question_count ?? 0) >= 100_000) {
    throw new Error("Your question-bank limit is full.");
  }
  if (Number(capacity?.pending_jobs ?? 0) >= 200) {
    throw new Error(
      "Your processing queue is full. Let current work finish before adding more.",
    );
  }

  return await db.transaction(async (tx) => {
    const [duplicate] = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.targetKey, targetKey),
          inArray(questions.lifecycle, ACTIVE_LIFECYCLES),
        ),
      )
      .limit(1);
    const [source] = await tx
      .insert(sources)
      .values({
        userId: input.userId,
        kind: "direct",
        status: "ready",
        title: prompt.slice(0, 160),
        rawText: body,
        byteSize: Buffer.byteLength(body, "utf8"),
        checksum: checksum(body),
        processingProgress: 100,
      })
      .returning({ id: sources.id });
    const [sourceVersion] = await tx
      .insert(sourceVersions)
      .values({
        userId: input.userId,
        sourceId: source.id,
        version: 1,
        bodyText: body,
        checksum: checksum(body),
      })
      .returning({ id: sourceVersions.id });
    const [evidence] = await tx
      .insert(evidenceSpans)
      .values({
        userId: input.userId,
        sourceVersionId: sourceVersion.id,
        section: "Learner attestation",
        startOffset: 0,
        endOffset: body.length,
        quote: body,
      })
      .returning({ id: evidenceSpans.id });
    const lifecycle: V2Lifecycle = "draft";
    const [question] = await tx
      .insert(questions)
      .values({
        userId: input.userId,
        lifecycle,
        targetKey,
      })
      .returning({ id: questions.id });
    const decision = duplicate
      ? "duplicate"
      : quality.passes
        ? "pending"
        : "rejected";
    const reasons = duplicate
      ? ["A question with the same recall target is already active."]
      : quality.reasons;
    const [version] = await tx
      .insert(questionVersions)
      .values({
        userId: input.userId,
        questionId: question.id,
        version: 1,
        prompt,
        referenceAnswer,
        displayAnswer,
        mode: input.answerMode,
        targetText: target,
        quality: decision,
        qualityReasons: reasons,
        duplicateOfQuestionId: duplicate?.id,
        learnerAttested: true,
      })
      .returning({ id: questionVersions.id });

    await tx.insert(questionEvidence).values([
      {
        userId: input.userId,
        questionVersionId: version.id,
        evidenceSpanId: evidence.id,
        requirement: "recall-target",
      },
      {
        userId: input.userId,
        questionVersionId: version.id,
        evidenceSpanId: evidence.id,
        requirement: "reference-answer",
      },
    ]);

    let jobId: string | null = null;
    if (decision === "pending") {
      const [job] = await tx
        .insert(jobs)
        .values({
          userId: input.userId,
          type: "activate_question",
          idempotencyKey: version.id,
          priority: 1,
          payload: { questionId: question.id, questionVersionId: version.id },
        })
        .returning({ id: jobs.id });
      jobId = job.id;
    }

    const response = { questionId: question.id, lifecycle, jobId };
    await tx
      .insert(mutationReceipts)
      .values({
        userId: input.userId,
        scope: "direct-question",
        key: input.idempotencyKey,
        requestHash,
        response,
      })
      .onConflictDoNothing();

    return response;
  });
}

async function currentQuestionVersion(userId: string, questionId: string) {
  const db = getV2Db();
  const [row] = await db
    .select({
      questionId: questions.id,
      lifecycle: questions.lifecycle,
      targetKey: questions.targetKey,
      importance: questions.importance,
      versionId: questionVersions.id,
      version: questionVersions.version,
      prompt: questionVersions.prompt,
      referenceAnswer: questionVersions.referenceAnswer,
      displayAnswer: questionVersions.displayAnswer,
      mode: questionVersions.mode,
      targetText: questionVersions.targetText,
      quality: questionVersions.quality,
      qualityReasons: questionVersions.qualityReasons,
      duplicateOfQuestionId: questionVersions.duplicateOfQuestionId,
      learnerAttested: questionVersions.learnerAttested,
      createdAt: questions.createdAt,
      updatedAt: questions.updatedAt,
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
      and(eq(questions.userId, userId), eq(questions.id, questionId)),
    )
    .limit(1);

  return row ?? null;
}

export async function activateQuestion(input: {
  userId: string;
  questionId: string;
  questionVersionId: string;
}): Promise<void> {
  const version = await currentQuestionVersion(input.userId, input.questionId);

  if (
    !version ||
    version.versionId !== input.questionVersionId ||
    version.lifecycle !== "draft"
  ) {
    return;
  }
  const quality = assessQuestionQuality({
    prompt: version.prompt,
    referenceAnswer: version.referenceAnswer,
    target: version.targetText,
  });
  const db = getV2Db();

  if (!quality.passes) {
    await db
      .update(questionVersions)
      .set({ quality: "rejected", qualityReasons: quality.reasons })
      .where(
        and(
          eq(questionVersions.userId, input.userId),
          eq(questionVersions.id, input.questionVersionId),
        ),
      );
    return;
  }

  const { model, embeddings } = await embedTexts({
    userId: input.userId,
    texts: [`${version.prompt}\n${version.referenceAnswer}`],
  });
  const embedding = embeddings[0];

  await db
    .insert(questionEmbeddings)
    .values({
      userId: input.userId,
      questionVersionId: input.questionVersionId,
      model,
      embedding,
    })
    .onConflictDoUpdate({
      target: [
        questionEmbeddings.userId,
        questionEmbeddings.questionVersionId,
        questionEmbeddings.model,
      ],
      set: { embedding, createdAt: new Date() },
    });

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`activation:${input.userId}`}))`,
    );
    const nearest = await getV2Client().pool.query<{
      question_id: string;
      similarity: number | string;
    }>(
      `SELECT q.id AS question_id,
              1 - (qe.embedding <=> $1::vector) AS similarity
         FROM waxon_v2.question_embeddings qe
         JOIN waxon_v2.question_versions qv
           ON qv.user_id = qe.user_id
          AND qv.id = qe.question_version_id
          AND qv.is_current = true
         JOIN waxon_v2.questions q
           ON q.user_id = qv.user_id
          AND q.id = qv.question_id
        WHERE q.user_id = $2
          AND q.id <> $3
          AND (
            q.lifecycle IN ('new', 'learning', 'review')
            OR (
              q.lifecycle = 'draft'
              AND qv.quality_decision = 'distinct'
            )
          )
        ORDER BY qe.embedding <=> $1::vector
        LIMIT 1`,
      [vectorLiteral(embedding), input.userId, input.questionId],
    );
    const candidate = nearest.rows[0];
    const similarity = candidate ? Number(candidate.similarity) : 0;
    const latest = await currentQuestionVersion(input.userId, input.questionId);
    if (
      !latest ||
      latest.versionId !== input.questionVersionId ||
      latest.lifecycle !== "draft"
    ) {
      return;
    }

    const [exactDuplicate] = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.targetKey, latest.targetKey),
          ne(questions.id, input.questionId),
          inArray(questions.lifecycle, ACTIVE_LIFECYCLES),
        ),
      )
      .limit(1);
    const duplicateId =
      exactDuplicate?.id ?? (similarity >= 0.94 ? candidate?.question_id : null);
    const uncertain = !duplicateId && similarity >= 0.86;

    if (duplicateId || uncertain) {
      await tx
        .update(questionVersions)
        .set({
          quality: duplicateId ? "duplicate" : "uncertain",
          qualityReasons: [
            duplicateId
              ? "A semantically equivalent active question already exists."
              : "This may overlap an existing question. Compare them before activation.",
          ],
          duplicateOfQuestionId: duplicateId,
        })
        .where(eq(questionVersions.id, input.questionVersionId));
      return;
    }

    await tx
      .update(questionVersions)
      .set({ quality: "distinct", qualityReasons: [] })
      .where(eq(questionVersions.id, input.questionVersionId));
    const [settings] = await tx
      .select({
        autoAcceptHighConfidence: learnerSettings.autoAcceptHighConfidence,
      })
      .from(learnerSettings)
      .where(eq(learnerSettings.userId, input.userId))
      .limit(1);
    if (latest.learnerAttested || settings?.autoAcceptHighConfidence) {
      await tx
        .update(questions)
        .set({ lifecycle: "new", updatedAt: new Date() })
        .where(
          and(
            eq(questions.userId, input.userId),
            eq(questions.id, input.questionId),
          ),
        );
      await tx
        .update(coverageTargets)
        .set({ status: "covered", updatedAt: new Date() })
        .where(
          and(
            eq(coverageTargets.userId, input.userId),
            sql`${coverageTargets.id} IN (
              SELECT tq.target_id
                FROM waxon_v2.target_questions tq
               WHERE tq.user_id = ${input.userId}
                 AND tq.question_id = ${input.questionId}
            )`,
          ),
        );
    }
  });
}

export async function runActivationJob(jobId: string): Promise<void> {
  const db = getV2Db();
  const job = await claimV2Job(jobId, "activate_question");
  if (!job) {
    return;
  }

  try {
    const questionId =
      typeof job.payload.questionId === "string"
        ? job.payload.questionId
        : "";
    const questionVersionId =
      typeof job.payload.questionVersionId === "string"
        ? job.payload.questionVersionId
        : "";
    await activateQuestion({
      userId: job.userId,
      questionId,
      questionVersionId,
    });
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        result: { questionId },
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = job.attempts;
    await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + attempts * 30_000),
        lockedUntil: null,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    throw error;
  }
}

export async function listLibrary(input: {
  userId: string;
  search?: string;
  lifecycle?: V2Lifecycle | "all";
  limit?: number;
}): Promise<V2LibraryResponse> {
  const pool = getV2Client().pool;
  const limit = Math.max(1, Math.min(QUESTION_PAGE_LIMIT, input.limit ?? 60));
  const search = input.search?.trim() ?? "";
  const lifecycle =
    input.lifecycle && input.lifecycle !== "all" ? input.lifecycle : null;
  const questionResult = await pool.query<{
    id: string;
    version_id: string;
    prompt: string;
    reference_answer: string;
    display_answer: string;
    answer_mode: V2AnswerMode;
    target_text: string;
    lifecycle: V2Lifecycle;
    quality: V2Question["quality"];
    quality_reasons: string[];
    duplicate_of_question_id: string | null;
    importance: number | string;
    due_at: Date | null;
    stability: number | string | null;
    difficulty: number | string | null;
    last_review_at: Date | null;
    elapsed_days: number | null;
    scheduled_days: number | null;
    reps: number | null;
    lapses: number | null;
    memory_state: number | null;
    learning_steps: number | null;
    concepts: string[];
    source_titles: string[];
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT q.id,
            qv.id AS version_id,
            qv.prompt,
            qv.reference_answer,
            qv.display_answer,
            qv.answer_mode,
            qv.target_text,
            q.lifecycle,
            qv.quality_decision AS quality,
            qv.quality_reasons,
            qv.duplicate_of_question_id,
            q.importance,
            ms.due_at,
            ms.stability,
            ms.difficulty,
            ms.last_review_at,
            ms.elapsed_days,
            ms.scheduled_days,
            ms.reps,
            ms.lapses,
            ms.state AS memory_state,
            ms.learning_steps,
            COALESCE((
              SELECT array_agg(DISTINCT c.name ORDER BY c.name)
              FROM waxon_v2.question_concepts qc
              JOIN waxon_v2.concepts c
                ON c.user_id = qc.user_id AND c.id = qc.concept_id
              WHERE qc.user_id = q.user_id AND qc.question_id = q.id
            ), ARRAY[]::text[]) AS concepts,
            COALESCE((
              SELECT array_agg(DISTINCT s.title ORDER BY s.title)
              FROM waxon_v2.question_evidence qe
              JOIN waxon_v2.evidence_spans es
                ON es.user_id = qe.user_id AND es.id = qe.evidence_span_id
              JOIN waxon_v2.source_versions sv
                ON sv.user_id = es.user_id AND sv.id = es.source_version_id
              JOIN waxon_v2.sources s
                ON s.user_id = sv.user_id AND s.id = sv.source_id
              WHERE qe.user_id = q.user_id AND qe.question_version_id = qv.id
            ), ARRAY[]::text[]) AS source_titles,
            q.created_at,
            q.updated_at
       FROM waxon_v2.questions q
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id
        AND qv.question_id = q.id
        AND qv.is_current = true
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1
        AND ($2::text IS NULL OR q.lifecycle::text = $2)
        AND ($3 = '' OR qv.prompt ILIKE '%' || $3 || '%'
                     OR qv.reference_answer ILIKE '%' || $3 || '%'
                     OR qv.target_text ILIKE '%' || $3 || '%')
      ORDER BY q.updated_at DESC, q.id
      LIMIT $4`,
    [input.userId, lifecycle, search, limit],
  );
  const settings = await getLearnerSettings(input.userId);
  const now = new Date();
  const questionsOut: V2Question[] = questionResult.rows.map((row) => {
    const memory =
      row.due_at &&
      row.stability !== null &&
      row.difficulty !== null &&
      row.elapsed_days !== null &&
      row.scheduled_days !== null &&
      row.reps !== null &&
      row.lapses !== null &&
      row.memory_state !== null &&
      row.learning_steps !== null
        ? {
            dueAt: row.due_at,
            lastReviewAt: row.last_review_at,
            stability: Number(row.stability),
            difficulty: Number(row.difficulty),
            elapsedDays: row.elapsed_days,
            scheduledDays: row.scheduled_days,
            reps: row.reps,
            lapses: row.lapses,
            state: row.memory_state,
            learningSteps: row.learning_steps,
          }
        : null;

    return {
      id: row.id,
      versionId: row.version_id,
      prompt: row.prompt,
      referenceAnswer: row.reference_answer,
      displayAnswer: row.display_answer,
      answerMode: row.answer_mode,
      target: row.target_text,
      lifecycle: row.lifecycle,
      quality: row.quality,
      qualityReasons: row.quality_reasons ?? [],
      duplicateOfQuestionId: row.duplicate_of_question_id,
      importance: Number(row.importance),
      dueAt: row.due_at?.toISOString() ?? null,
      retrievability: memory
        ? memoryRetrievability({
            memory,
            desiredRetention: settings.desiredRetention,
            at: now,
          })
        : null,
      concepts: row.concepts ?? [],
      sourceTitles: row.source_titles ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
  const countRows = await pool.query<{ lifecycle: V2Lifecycle; count: string }>(
    `SELECT lifecycle, count(*)::text AS count
       FROM waxon_v2.questions
      WHERE user_id = $1
      GROUP BY lifecycle`,
    [input.userId],
  );
  const counts = {
    draft: 0,
    new: 0,
    learning: 0,
    review: 0,
    paused: 0,
    archived: 0,
    suspended: 0,
    trash: 0,
    superseded: 0,
  } satisfies Record<V2Lifecycle, number>;
  for (const row of countRows.rows) {
    counts[row.lifecycle] = Number(row.count);
  }
  const sourceRows = await pool.query<{
    id: string;
    kind: V2Source["kind"];
    status: V2Source["status"];
    title: string;
    original_url: string | null;
    processing_progress: number;
    error: string | null;
    created_at: Date;
    covered: string;
    weak: string;
    missing: string;
    ignored: string;
    unresolved: string;
    has_more_analysis: boolean;
    run_id: string | null;
    run_status: NonNullable<V2Source["run"]>["status"] | null;
    run_stage: string | null;
    run_progress: number | null;
    residual_count: number | null;
  }>(
    `SELECT s.id, s.kind, s.status, s.title, s.original_url,
            s.processing_progress, s.error, s.created_at,
            count(*) FILTER (WHERE ct.status = 'covered')::text AS covered,
            count(*) FILTER (WHERE ct.status = 'weak')::text AS weak,
            count(*) FILTER (WHERE ct.status = 'missing')::text AS missing,
            count(*) FILTER (WHERE ct.status = 'ignored')::text AS ignored,
            count(*) FILTER (WHERE ct.status = 'unresolved')::text AS unresolved,
            COALESCE(
              bool_or(ct.target_type = 'analysis-pending')
                OR COALESCE(jsonb_array_length(gr.residuals), 0) > 0,
              false
            ) AS has_more_analysis,
            gr.id AS run_id,
            gr.status AS run_status,
            gr.stage AS run_stage,
            gr.progress AS run_progress,
            COALESCE(jsonb_array_length(gr.residuals), 0)::int AS residual_count
       FROM waxon_v2.sources s
       LEFT JOIN waxon_v2.generation_runs gr
         ON gr.user_id = s.user_id AND gr.id = s.active_run_id
       LEFT JOIN waxon_v2.coverage_targets ct
         ON ct.user_id = s.user_id AND ct.source_id = s.id
      WHERE s.user_id = $1
      GROUP BY s.id, gr.id
      ORDER BY s.created_at DESC
      LIMIT 100`,
    [input.userId],
  );
  const masteryRows = await pool.query<{
    source_id: string;
    target_id: string;
    target_status: string;
    question_id: string | null;
    lifecycle: V2Lifecycle | null;
    latest_grade: V2Grade | null;
    due_at: Date | null;
    last_review_at: Date | null;
    stability: number | string | null;
    difficulty: number | string | null;
    elapsed_days: number | null;
    scheduled_days: number | null;
    reps: number | null;
    lapses: number | null;
    memory_state: number | null;
    learning_steps: number | null;
  }>(
    `SELECT ct.source_id,
            ct.id AS target_id,
            ct.status AS target_status,
            q.id AS question_id,
            q.lifecycle,
            latest_grade.value AS latest_grade,
            ms.due_at,
            ms.last_review_at,
            ms.stability,
            ms.difficulty,
            ms.elapsed_days,
            ms.scheduled_days,
            ms.reps,
            ms.lapses,
            ms.state AS memory_state,
            ms.learning_steps
       FROM waxon_v2.coverage_targets ct
       LEFT JOIN waxon_v2.target_questions tq
         ON tq.user_id = ct.user_id AND tq.target_id = ct.id
       LEFT JOIN waxon_v2.questions q
         ON q.user_id = tq.user_id AND q.id = tq.question_id
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
       LEFT JOIN LATERAL (
         SELECT ge.grade AS value
           FROM waxon_v2.answer_submissions a
           JOIN waxon_v2.grade_events ge
             ON ge.user_id = a.user_id AND ge.submission_id = a.id
          WHERE a.user_id = q.user_id AND a.question_id = q.id
          ORDER BY ge.created_at DESC
          LIMIT 1
       ) latest_grade ON true
      WHERE ct.user_id = $1 AND ct.requirement = 'required'`,
    [input.userId],
  );
  const masteryBySource = new Map<
    string,
    Map<string, { mastered: boolean; attempted: boolean; covered: boolean }>
  >();
  for (const row of masteryRows.rows) {
    let sourceTargets = masteryBySource.get(row.source_id);
    if (!sourceTargets) {
      sourceTargets = new Map();
      masteryBySource.set(row.source_id, sourceTargets);
    }
    const state = sourceTargets.get(row.target_id) ?? {
      mastered: false,
      attempted: false,
      covered: row.target_status === "covered",
    };
    state.covered ||= row.target_status === "covered";
    state.attempted ||= row.latest_grade !== null;
    if (
      row.lifecycle &&
      ACTIVE_LIFECYCLES.includes(row.lifecycle) &&
      (row.latest_grade === "good" || row.latest_grade === "easy") &&
      row.due_at &&
      row.stability !== null &&
      row.difficulty !== null &&
      row.elapsed_days !== null &&
      row.scheduled_days !== null &&
      row.reps !== null &&
      row.lapses !== null &&
      row.memory_state !== null &&
      row.learning_steps !== null
    ) {
      const retrievability = memoryRetrievability({
        memory: {
          dueAt: row.due_at,
          lastReviewAt: row.last_review_at,
          stability: Number(row.stability),
          difficulty: Number(row.difficulty),
          elapsedDays: row.elapsed_days,
          scheduledDays: row.scheduled_days,
          reps: row.reps,
          lapses: row.lapses,
          state: row.memory_state,
          learningSteps: row.learning_steps,
        },
        desiredRetention: settings.desiredRetention,
        at: now,
      });
      state.mastered ||= retrievability >= settings.desiredRetention;
    }
    sourceTargets.set(row.target_id, state);
  }
  const conceptRows = await pool.query<{
    id: string;
    name: string;
    slug: string;
    count: string;
  }>(
    `SELECT c.id, c.name, c.slug, count(qc.question_id)::text AS count
       FROM waxon_v2.concepts c
       LEFT JOIN waxon_v2.question_concepts qc
         ON qc.user_id = c.user_id AND qc.concept_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY count(qc.question_id) DESC, c.name
      LIMIT 200`,
    [input.userId],
  );
  const [health] = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM waxon_v2.questions q
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id
        AND qv.question_id = q.id
        AND qv.is_current = true
      WHERE q.user_id = $1
        AND (q.lifecycle IN ('draft', 'suspended')
          OR qv.quality_decision IN ('uncertain', 'duplicate', 'rejected'))`,
    [input.userId],
  ).then((result) => result.rows);

  return {
    questions: questionsOut,
    sources: sourceRows.rows.map((row) => {
      const targets = [...(masteryBySource.get(row.id)?.values() ?? [])];
      const masteredTargets = targets.filter((target) => target.mastered).length;
      const requiredTargets = targets.length;
      const currentlyMastered =
        requiredTargets > 0 &&
        masteredTargets === requiredTargets &&
        targets.every((target) => target.covered);
      const attempted = targets.some((target) => target.attempted);
      const runStatus = row.run_status;
      const questionSetStatus =
        runStatus === "ready"
          ? "ready"
          : runStatus === "needs_attention" ||
              runStatus === "failed" ||
              runStatus === "cancelled"
            ? "needs_attention"
            : row.status === "ready"
              ? "ready"
              : "building";
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        title: row.title,
        originalUrl: row.original_url,
        progress: row.run_progress ?? row.processing_progress,
        error: row.error,
        hasMoreAnalysis: row.has_more_analysis,
        questionSetStatus,
        mastery: {
          status: currentlyMastered
            ? "currently_mastered"
            : attempted
              ? "in_progress"
              : "not_started",
          masteredTargets,
          requiredTargets,
        },
        run: row.run_id && runStatus
          ? {
              id: row.run_id,
              status: runStatus,
              stage: row.run_stage ?? "Preparing",
              progress: row.run_progress ?? 0,
              residualCount: row.residual_count ?? 0,
            }
          : null,
        coverage: {
          covered: Number(row.covered),
          weak: Number(row.weak),
          missing: Number(row.missing),
          ignored: Number(row.ignored),
          unresolved: Number(row.unresolved),
        },
        createdAt: row.created_at.toISOString(),
      } satisfies V2Source;
    }),
    counts,
    concepts: conceptRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      count: Number(row.count),
    })),
    waitingNew: counts.new,
    healthCount: Number(health?.count ?? 0),
  };
}

async function planCandidates(userId: string): Promise<PlanCandidate[]> {
  const db = getV2Db();
  const rows = await db
    .select({
      questionId: questions.id,
      questionVersionId: questionVersions.id,
      lifecycle: questions.lifecycle,
      answerMode: questionVersions.mode,
      dueAt: memoryStates.dueAt,
      importance: questions.importance,
      createdAt: questions.createdAt,
      memory: {
        dueAt: memoryStates.dueAt,
        lastReviewAt: memoryStates.lastReviewAt,
        stability: memoryStates.stability,
        difficulty: memoryStates.difficulty,
        elapsedDays: memoryStates.elapsedDays,
        scheduledDays: memoryStates.scheduledDays,
        reps: memoryStates.reps,
        lapses: memoryStates.lapses,
        state: memoryStates.state,
        learningSteps: memoryStates.learningSteps,
      },
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
    .leftJoin(
      memoryStates,
      and(
        eq(memoryStates.userId, questions.userId),
        eq(memoryStates.questionId, questions.id),
      ),
    )
    .where(
      and(
        eq(questions.userId, userId),
        inArray(questions.lifecycle, ACTIVE_LIFECYCLES),
        eq(questionVersions.quality, "distinct"),
        sql`NOT EXISTS (
          SELECT 1 FROM waxon_v2.answer_submissions pending
          WHERE pending.user_id = ${questions.userId}
            AND pending.question_id = ${questions.id}
            AND pending.status = 'pending'
        )`,
      ),
    )
    .orderBy(asc(memoryStates.dueAt), asc(questions.createdAt))
    .limit(2_000);
  const settings = await getLearnerSettings(userId);
  const horizon = new Date(Date.now() + 24 * 60 * 60_000);

  return rows.map((row) => {
    const memory =
      row.memory?.dueAt && row.memory.stability !== null
        ? storedMemory(row.memory)
        : null;
    return {
      questionId: row.questionId,
      questionVersionId: row.questionVersionId,
      lifecycle: row.lifecycle,
      answerMode: row.answerMode,
      dueAt: row.dueAt,
      retrievability: memory
        ? memoryRetrievability({
            memory,
            desiredRetention: settings.desiredRetention,
            at: horizon,
          })
        : null,
      importance: row.importance,
      hasGap: false,
      createdAt: row.createdAt,
    };
  });
}

async function reviewCapacity(userId: string) {
  const settings = await getLearnerSettings(userId);
  const pool = getV2Client().pool;
  const [row] = await pool
    .query<{
      at_risk: string;
      waiting_new: string;
      oldest_new_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE q.lifecycle IN ('learning','review')
             AND ms.due_at <= now() + interval '24 hours'
         )::text AS at_risk,
         count(*) FILTER (WHERE q.lifecycle = 'new')::text AS waiting_new,
         min(q.created_at) FILTER (WHERE q.lifecycle = 'new') AS oldest_new_at
       FROM waxon_v2.questions q
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1`,
      [userId],
    )
    .then((result) => result.rows);
  const atRiskCount = Number(row?.at_risk ?? 0);
  const roughCapacity = Math.max(1, Math.floor((settings.dailyMinutes * 60) / 120));
  const targetFeasible = atRiskCount <= roughCapacity;
  const pressure = atRiskCount
    ? Math.min(1, Math.max(0, (atRiskCount - roughCapacity) / atRiskCount))
    : 0;

  return {
    targetFeasible,
    sustainableRetention: targetFeasible
      ? settings.desiredRetention
      : Math.max(0.7, settings.desiredRetention - pressure * 0.2),
    minutesNeeded: Math.max(
      settings.dailyMinutes,
      Math.ceil((atRiskCount * 120) / 60),
    ),
    atRiskCount,
    waitingNew: Number(row?.waiting_new ?? 0),
    oldestNewAt: row?.oldest_new_at?.toISOString() ?? null,
  };
}

async function exposeNextItem(
  userId: string,
  sessionId: string,
): Promise<V2ReviewItem | null> {
  const db = getV2Db();
  const now = new Date();

  return await db.transaction(async (tx) => {
    const [exposed] = await tx
      .select({
        itemId: reviewSessionItems.id,
        questionId: reviewSessionItems.questionId,
        questionVersionId: reviewSessionItems.questionVersionId,
        prompt: questionVersions.prompt,
        answerMode: questionVersions.mode,
        position: reviewSessionItems.position,
        kind: reviewSessionItems.kind,
      })
      .from(reviewSessionItems)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.userId, reviewSessionItems.userId),
          eq(questionVersions.id, reviewSessionItems.questionVersionId),
        ),
      )
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, sessionId),
          eq(reviewSessionItems.state, "exposed"),
        ),
      )
      .orderBy(asc(reviewSessionItems.position))
      .limit(1);
    const row =
      exposed ??
      (
        await tx
          .select({
            itemId: reviewSessionItems.id,
            questionId: reviewSessionItems.questionId,
            questionVersionId: reviewSessionItems.questionVersionId,
            prompt: questionVersions.prompt,
            answerMode: questionVersions.mode,
            position: reviewSessionItems.position,
            kind: reviewSessionItems.kind,
          })
          .from(reviewSessionItems)
          .innerJoin(
            questionVersions,
            and(
              eq(questionVersions.userId, reviewSessionItems.userId),
              eq(questionVersions.id, reviewSessionItems.questionVersionId),
            ),
          )
          .where(
            and(
              eq(reviewSessionItems.userId, userId),
              eq(reviewSessionItems.sessionId, sessionId),
              eq(reviewSessionItems.state, "queued"),
              lte(reviewSessionItems.earliestAt, now),
              sql`NOT EXISTS (
                SELECT 1 FROM waxon_v2.answer_submissions pending
                WHERE pending.user_id = ${reviewSessionItems.userId}
                  AND pending.question_id = ${reviewSessionItems.questionId}
                  AND pending.status = 'pending'
              )`,
            ),
          )
          .orderBy(asc(reviewSessionItems.position))
          .limit(1)
      )[0];

    if (!row) {
      return null;
    }
    if (!exposed) {
      await tx
        .update(reviewSessionItems)
        .set({ state: "exposed", exposedAt: now })
        .where(
          and(
            eq(reviewSessionItems.userId, userId),
            eq(reviewSessionItems.id, row.itemId),
            eq(reviewSessionItems.state, "queued"),
          ),
        );
      if (row.kind === "retry") {
        await tx
          .update(retryObligations)
          .set({ status: "exposed", updatedAt: now })
          .where(
            and(
              eq(retryObligations.userId, userId),
              eq(retryObligations.sessionId, sessionId),
              eq(retryObligations.questionId, row.questionId),
              or(
                eq(retryObligations.status, "queued"),
                eq(retryObligations.status, "deferred"),
              ),
            ),
          );
      }
    }

    const [{ itemCount }] = await tx
      .select({ itemCount: count() })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, sessionId),
          ne(reviewSessionItems.state, "invalidated"),
        ),
      );
    const conceptsForQuestion = await tx
      .select({ name: concepts.name })
      .from(questionConcepts)
      .innerJoin(
        concepts,
        and(
          eq(concepts.userId, questionConcepts.userId),
          eq(concepts.id, questionConcepts.conceptId),
        ),
      )
      .where(
        and(
          eq(questionConcepts.userId, userId),
          eq(questionConcepts.questionId, row.questionId),
        ),
      )
      .orderBy(asc(concepts.name));
    const [session] = await tx
      .select({ estimatedSeconds: reviewSessions.estimatedSeconds })
      .from(reviewSessions)
      .where(eq(reviewSessions.id, sessionId))
      .limit(1);

    return {
      sessionId,
      itemId: row.itemId,
      questionId: row.questionId,
      questionVersionId: row.questionVersionId,
      prompt: row.prompt,
      answerMode: row.answerMode,
      concepts: conceptsForQuestion.map((item) => item.name),
      position: row.position,
      total: itemCount,
      estimatedMinutes: Math.max(
        1,
        Math.ceil((session?.estimatedSeconds ?? 60) / 60),
      ),
      isRetry: row.kind === "retry",
    };
  });
}

export async function getOrCreateReviewSession(
  userId: string,
): Promise<V2ReviewSessionResponse> {
  const db = getV2Db();
  const settings = await getLearnerSettings(userId);
  const [existingSession] = await db
    .select()
    .from(reviewSessions)
    .where(
      and(
        eq(reviewSessions.userId, userId),
        eq(reviewSessions.status, "active"),
      ),
    )
    .limit(1);
  let session: typeof reviewSessions.$inferSelect | undefined =
    existingSession;

  if (!session) {
    const candidates = await planCandidates(userId);
    const plan = buildReviewPlan({
      candidates,
      timeBudgetMinutes: settings.dailyMinutes,
      desiredRetention: settings.desiredRetention,
      newItemsPerDay: settings.newItemsPerDay,
    });

    if (plan.length > 0) {
      session = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`session:${userId}`}))`,
        );
        const [existing] = await tx
          .select()
          .from(reviewSessions)
          .where(
            and(
              eq(reviewSessions.userId, userId),
              eq(reviewSessions.status, "active"),
            ),
          )
          .limit(1);
        if (existing) {
          return existing;
        }
        const [created] = await tx
          .insert(reviewSessions)
          .values({
            userId,
            timeBudgetMinutes: settings.dailyMinutes,
            desiredRetention: settings.desiredRetention,
            estimatedSeconds: plan.reduce(
              (sum, item) => sum + item.estimatedSeconds,
              0,
            ),
            plannedCount: plan.length,
          })
          .returning();
        await tx.insert(reviewSessionItems).values(
          plan.map((item) => ({
            userId,
            sessionId: created.id,
            questionId: item.questionId,
            questionVersionId: item.questionVersionId,
            position: item.position,
            earliestAt: new Date(),
          })),
        );
        const newQuestionIds = plan
          .filter((item) => item.lifecycle === "new")
          .map((item) => item.questionId);
        if (newQuestionIds.length > 0) {
          await tx
            .update(questions)
            .set({ lifecycle: "learning", updatedAt: new Date() })
            .where(
              and(
                eq(questions.userId, userId),
                inArray(questions.id, newQuestionIds),
              ),
            );
        }
        return created;
      });
    }
  }

  const item = session ? await exposeNextItem(userId, session.id) : null;
  if (session && !item) {
    const [{ unfinished }] = await db
      .select({
        unfinished: count(),
      })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, session.id),
          inArray(reviewSessionItems.state, [
            "queued",
            "exposed",
            "submitted",
          ]),
        ),
      );
    if (unfinished === 0) {
      await db
        .update(reviewSessions)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reviewSessions.id, session.id));
      session = undefined;
    }
  }
  const summary = await getReviewSummary(userId);
  const capacity = await reviewCapacity(userId);
  let completedCount = 0;
  let retryAvailableAt: string | null = null;
  if (session) {
    const [{ completed }] = await db
      .select({ completed: count() })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, session.id),
          eq(reviewSessionItems.state, "evaluated"),
        ),
      );
    completedCount = completed;
    if (!item) {
      const [retry] = await db
        .select({ earliestAt: reviewSessionItems.earliestAt })
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, userId),
            eq(reviewSessionItems.sessionId, session.id),
            eq(reviewSessionItems.kind, "retry"),
            eq(reviewSessionItems.state, "queued"),
          ),
        )
        .orderBy(asc(reviewSessionItems.earliestAt))
        .limit(1);
      retryAvailableAt = retry?.earliestAt.toISOString() ?? null;
    }
  }

  return {
    session: session
      ? {
          id: session.id,
          plannedCount: session.plannedCount,
          estimatedMinutes: Math.max(
            1,
            Math.ceil(session.estimatedSeconds / 60),
          ),
          completedCount,
        }
      : null,
    item,
    retryAvailableAt,
    summary,
    capacity,
  };
}

export async function getReviewSummary(
  userId: string,
): Promise<V2ReviewSummary> {
  const pool = getV2Client().pool;
  const [row] = await pool
    .query<{ due_count: string; next_due: Date | null }>(
      `SELECT count(*) FILTER (
                WHERE q.lifecycle IN ('learning','review')
                  AND ms.due_at <= now()
                  AND NOT EXISTS (
                    SELECT 1 FROM waxon_v2.answer_submissions pending
                    WHERE pending.user_id = q.user_id
                      AND pending.question_id = q.id
                      AND pending.status = 'pending'
                  )
              )::text AS due_count,
              min(ms.due_at) FILTER (WHERE ms.due_at > now()) AS next_due
         FROM waxon_v2.questions q
         LEFT JOIN waxon_v2.memory_states ms
           ON ms.user_id = q.user_id AND ms.question_id = q.id
        WHERE q.user_id = $1`,
      [userId],
    )
    .then((result) => result.rows);
  return {
    queueRemaining: Number(row?.due_count ?? 0),
    nextScheduledDue: row?.next_due?.getTime() ?? null,
  };
}

async function applyGradeInTransaction(
  tx: Parameters<Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]>[0],
  input: {
    userId: string;
    submissionId: string;
    grade: V2Grade;
    origin: "deterministic" | "model" | "self" | "correction";
    evaluationId?: string | null;
  },
) {
  const [submission] = await tx
    .select({
      id: answerSubmissions.id,
      questionId: answerSubmissions.questionId,
      questionVersionId: answerSubmissions.questionVersionId,
      sessionItemId: answerSubmissions.sessionItemId,
      status: answerSubmissions.status,
    })
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, input.submissionId),
      ),
    )
    .limit(1);
  if (!submission) {
    throw new Error("Submission not found.");
  }
  const [item] = await tx
    .select()
    .from(reviewSessionItems)
    .where(
      and(
        eq(reviewSessionItems.userId, input.userId),
        eq(reviewSessionItems.id, submission.sessionItemId),
      ),
    )
    .limit(1);
  if (!item) {
    throw new Error("Review item not found.");
  }
  const [settings] = await tx
    .select()
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, input.userId))
    .limit(1);
  const [memory] = await tx
    .select()
    .from(memoryStates)
    .where(
      and(
        eq(memoryStates.userId, input.userId),
        eq(memoryStates.questionId, submission.questionId),
      ),
    )
    .limit(1);
  const next = applyFsrsGrade({
    memory: storedMemory(memory),
    grade: input.grade,
    desiredRetention: settings?.desiredRetention ?? 0.9,
  });
  const [event] = await tx
    .insert(gradeEvents)
    .values({
      userId: input.userId,
      submissionId: input.submissionId,
      value: input.grade,
      origin: input.origin,
      evaluationId: input.evaluationId ?? null,
    })
    .returning({ id: gradeEvents.id });
  await tx
    .insert(memoryStates)
    .values({
      userId: input.userId,
      questionId: submission.questionId,
      dueAt: next.dueAt,
      lastReviewAt: next.lastReviewAt,
      stability: next.stability,
      difficulty: next.difficulty,
      elapsedDays: next.elapsedDays,
      scheduledDays: next.scheduledDays,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state,
      learningSteps: next.learningSteps,
      schedulerVersion: SCHEDULER_VERSION,
    })
    .onConflictDoUpdate({
      target: [memoryStates.userId, memoryStates.questionId],
      set: {
        dueAt: next.dueAt,
        lastReviewAt: next.lastReviewAt,
        stability: next.stability,
        difficulty: next.difficulty,
        elapsedDays: next.elapsedDays,
        scheduledDays: next.scheduledDays,
        reps: next.reps,
        lapses: next.lapses,
        state: next.state,
        learningSteps: next.learningSteps,
        schedulerVersion: SCHEDULER_VERSION,
        updatedAt: new Date(),
      },
    });
  await tx
    .update(answerSubmissions)
    .set({ status: "graded" })
    .where(eq(answerSubmissions.id, input.submissionId));
  await tx
    .update(reviewSessionItems)
    .set({ state: "evaluated" })
    .where(eq(reviewSessionItems.id, item.id));
  await tx
    .update(questions)
    .set({ lifecycle: "review", updatedAt: new Date() })
    .where(
      and(
        eq(questions.userId, input.userId),
        eq(questions.id, submission.questionId),
      ),
    );

  if (item.kind === "retry") {
    await tx
      .update(retryObligations)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.sessionId, item.sessionId),
          eq(retryObligations.questionId, item.questionId),
          eq(retryObligations.status, "exposed"),
        ),
      );
    return event;
  }

  if (input.grade === "again") {
    const [existing] = await tx
      .select()
      .from(retryObligations)
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.firstSubmissionId, input.submissionId),
        ),
      )
      .limit(1);
    if (!existing) {
      const [differentAfter] = await tx
        .select({ id: reviewSessionItems.id })
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.sessionId, item.sessionId),
            ne(reviewSessionItems.questionId, item.questionId),
            sql`${reviewSessionItems.position} > ${item.position}`,
            ne(reviewSessionItems.state, "invalidated"),
          ),
        )
        .limit(1);
      const [maxPosition] = await tx
        .select({
          value: sql<number>`COALESCE(max(${reviewSessionItems.position}), -1)`,
        })
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.sessionId, item.sessionId),
          ),
        );
      const earliestAt = retryEarliestAt({
        hasDifferentQuestionAfter: Boolean(differentAfter),
      });
      await tx.insert(retryObligations).values({
        userId: input.userId,
        firstSubmissionId: input.submissionId,
        questionId: item.questionId,
        questionVersionId: item.questionVersionId,
        sessionId: item.sessionId,
        earliestAt,
      });
      await tx.insert(reviewSessionItems).values({
        userId: input.userId,
        sessionId: item.sessionId,
        questionId: item.questionId,
        questionVersionId: item.questionVersionId,
        kind: "retry",
        position: Number(maxPosition?.value ?? -1) + 1,
        earliestAt,
      });
    }
  } else {
    await tx
      .update(retryObligations)
      .set({
        status: "cancelled",
        reason: "The effective first grade no longer requires a retry.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.firstSubmissionId, input.submissionId),
          or(
            eq(retryObligations.status, "queued"),
            eq(retryObligations.status, "deferred"),
          ),
        ),
      );
  }

  return event;
}

async function rebuildQuestionMemoryInTransaction(
  tx: Parameters<Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]>[0],
  input: {
    userId: string;
    questionId: string;
    sourceQuestionIds?: string[];
  },
): Promise<void> {
  const [settings] = await tx
    .select({ desiredRetention: learnerSettings.desiredRetention })
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, input.userId))
    .limit(1);
  const rows = await tx
    .select({
      submissionId: answerSubmissions.id,
      submittedAt: answerSubmissions.submittedAt,
      eventCreatedAt: gradeEvents.createdAt,
      value: gradeEvents.value,
    })
    .from(answerSubmissions)
    .innerJoin(
      gradeEvents,
      and(
        eq(gradeEvents.userId, answerSubmissions.userId),
        eq(gradeEvents.submissionId, answerSubmissions.id),
      ),
    )
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        inArray(
          answerSubmissions.questionId,
          input.sourceQuestionIds ?? [input.questionId],
        ),
        eq(answerSubmissions.status, "graded"),
      ),
    )
    .orderBy(
      asc(answerSubmissions.submittedAt),
      asc(gradeEvents.createdAt),
      asc(gradeEvents.id),
    );
  const latestBySubmission = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    latestBySubmission.set(row.submissionId, row);
  }
  const effective = [...latestBySubmission.values()].sort(
    (left, right) =>
      left.submittedAt.getTime() - right.submittedAt.getTime() ||
      left.eventCreatedAt.getTime() - right.eventCreatedAt.getTime(),
  );
  let memory: StoredMemoryState | null = null;
  let priorReviewAt = 0;
  for (const row of effective) {
    const reviewAt = new Date(
      Math.max(row.submittedAt.getTime(), priorReviewAt + 1),
    );
    memory = applyFsrsGrade({
      memory,
      grade: row.value,
      desiredRetention: settings?.desiredRetention ?? 0.9,
      now: reviewAt,
    });
    priorReviewAt = reviewAt.getTime();
  }
  if (!memory) {
    await tx
      .delete(memoryStates)
      .where(
        and(
          eq(memoryStates.userId, input.userId),
          eq(memoryStates.questionId, input.questionId),
        ),
      );
    return;
  }
  await tx
    .insert(memoryStates)
    .values({
      userId: input.userId,
      questionId: input.questionId,
      dueAt: memory.dueAt,
      lastReviewAt: memory.lastReviewAt,
      stability: memory.stability,
      difficulty: memory.difficulty,
      elapsedDays: memory.elapsedDays,
      scheduledDays: memory.scheduledDays,
      reps: memory.reps,
      lapses: memory.lapses,
      state: memory.state,
      learningSteps: memory.learningSteps,
      schedulerVersion: SCHEDULER_VERSION,
    })
    .onConflictDoUpdate({
      target: [memoryStates.userId, memoryStates.questionId],
      set: {
        dueAt: memory.dueAt,
        lastReviewAt: memory.lastReviewAt,
        stability: memory.stability,
        difficulty: memory.difficulty,
        elapsedDays: memory.elapsedDays,
        scheduledDays: memory.scheduledDays,
        reps: memory.reps,
        lapses: memory.lapses,
        state: memory.state,
        learningSteps: memory.learningSteps,
        schedulerVersion: SCHEDULER_VERSION,
        updatedAt: new Date(),
      },
    });
}

export async function submitReviewAnswer(input: {
  userId: string;
  itemId: string;
  answer: string;
}): Promise<V2Evaluation> {
  const db = getV2Db();
  const now = new Date();

  return await db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: reviewSessionItems.id,
        questionId: reviewSessionItems.questionId,
        questionVersionId: reviewSessionItems.questionVersionId,
        state: reviewSessionItems.state,
        prompt: questionVersions.prompt,
        referenceAnswer: questionVersions.referenceAnswer,
        mode: questionVersions.mode,
      })
      .from(reviewSessionItems)
      .innerJoin(
        questionVersions,
        and(
          eq(questionVersions.userId, reviewSessionItems.userId),
          eq(questionVersions.id, reviewSessionItems.questionVersionId),
        ),
      )
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.id, input.itemId),
        ),
      )
      .limit(1);
    if (!item || item.state !== "exposed") {
      const [existing] = await tx
        .select({ id: answerSubmissions.id })
        .from(answerSubmissions)
        .where(
          and(
            eq(answerSubmissions.userId, input.userId),
            eq(answerSubmissions.sessionItemId, input.itemId),
          ),
        )
        .limit(1);
      if (existing) {
        return await getEvaluationForSubmission(input.userId, existing.id);
      }
      throw new Error("This Review item is no longer answerable.");
    }
    const [submission] = await tx
      .insert(answerSubmissions)
      .values({
        userId: input.userId,
        questionId: item.questionId,
        questionVersionId: item.questionVersionId,
        sessionItemId: item.id,
        answer: input.answer.trim(),
        submittedAt: now,
      })
      .returning({ id: answerSubmissions.id });
    await tx
      .update(reviewSessionItems)
      .set({ state: "submitted", submittedAt: now })
      .where(eq(reviewSessionItems.id, item.id));

    if (item.mode === "exact") {
      const accepted = item.referenceAnswer
        .split(/\n|\|/gu)
        .map(normalizeExactAnswer)
        .filter(Boolean);
      const matched = accepted.includes(normalizeExactAnswer(input.answer));
      const [evaluation] = await tx
        .insert(evaluations)
        .values({
          userId: input.userId,
          submissionId: submission.id,
          status: "complete",
          evaluator: "deterministic-exact",
          proposedGrade: matched ? "easy" : "again",
          feedback: matched
            ? "Correct."
            : `Expected ${item.referenceAnswer}; your normalized answer did not match.`,
          expectedAnswer: item.referenceAnswer,
          coveredPoints: matched ? [item.referenceAnswer] : [],
          missingPoints: matched ? [] : [item.referenceAnswer],
          demonstratedGap: matched ? null : "The exact form was not recalled.",
          confidence: 1,
          completedAt: now,
        })
        .returning({ id: evaluations.id });
      await applyGradeInTransaction(tx, {
        userId: input.userId,
        submissionId: submission.id,
        grade: matched ? "easy" : "again",
        origin: "deterministic",
        evaluationId: evaluation.id,
      });
      return {
        submissionId: submission.id,
        evaluationId: evaluation.id,
        status: "complete",
        grade: matched ? "easy" : "again",
        feedback: matched
          ? "Correct."
          : `Expected ${item.referenceAnswer}; your normalized answer did not match.`,
        expectedAnswer: item.referenceAnswer,
        coveredPoints: matched ? [item.referenceAnswer] : [],
        missingPoints: matched ? [] : [item.referenceAnswer],
        demonstratedGap: matched ? null : "The exact form was not recalled.",
        confidence: 1,
        canSelfGrade: true,
      };
    }

    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        userId: input.userId,
        submissionId: submission.id,
        evaluator: "model",
      })
      .returning({ id: evaluations.id });
    await tx.insert(jobs).values({
      userId: input.userId,
      type: "evaluate_submission",
      idempotencyKey: submission.id,
      priority: 0,
      payload: {
        submissionId: submission.id,
        evaluationId: evaluation.id,
      },
    });

    return {
      submissionId: submission.id,
      evaluationId: evaluation.id,
      status: "pending",
      grade: null,
      feedback: null,
      expectedAnswer: null,
      coveredPoints: [],
      missingPoints: [],
      demonstratedGap: null,
      confidence: null,
      canSelfGrade: true,
    };
  });
}

export async function getEvaluationForSubmission(
  userId: string,
  submissionId: string,
): Promise<V2Evaluation> {
  const db = getV2Db();
  const [row] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.userId, userId),
        eq(evaluations.submissionId, submissionId),
      ),
    )
    .orderBy(desc(evaluations.createdAt))
    .limit(1);

  if (!row) {
    throw new Error("Evaluation not found.");
  }
  const [effectiveGrade] = await db
    .select({ value: gradeEvents.value })
    .from(gradeEvents)
    .where(
      and(
        eq(gradeEvents.userId, userId),
        eq(gradeEvents.submissionId, submissionId),
      ),
    )
    .orderBy(desc(gradeEvents.createdAt), desc(gradeEvents.id))
    .limit(1);
  return {
    submissionId,
    evaluationId: row.id,
    status:
      row.status === "complete" || effectiveGrade
        ? "complete"
        : row.status === "failed"
          ? "failed"
          : "pending",
    grade: effectiveGrade?.value ?? row.proposedGrade,
    feedback: row.feedback,
    expectedAnswer: row.expectedAnswer,
    coveredPoints: row.coveredPoints,
    missingPoints: row.missingPoints,
    demonstratedGap: row.demonstratedGap,
    confidence: row.confidence,
    canSelfGrade: true,
  };
}

export async function runEvaluationJob(jobId: string): Promise<void> {
  const db = getV2Db();
  const job = await claimV2Job(jobId, "evaluate_submission");
  if (!job) {
    return;
  }
  const submissionId =
    typeof job.payload.submissionId === "string"
      ? job.payload.submissionId
      : "";
  const evaluationId =
    typeof job.payload.evaluationId === "string"
      ? job.payload.evaluationId
      : "";
  const [row] = await db
    .select({
      submissionStatus: answerSubmissions.status,
      answer: answerSubmissions.answer,
      prompt: questionVersions.prompt,
      referenceAnswer: questionVersions.referenceAnswer,
      mode: questionVersions.mode,
    })
    .from(answerSubmissions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.userId, answerSubmissions.userId),
        eq(questionVersions.id, answerSubmissions.questionVersionId),
      ),
    )
    .where(
      and(
        eq(answerSubmissions.userId, job.userId),
        eq(answerSubmissions.id, submissionId),
      ),
    )
    .limit(1);
  if (!row || row.submissionStatus !== "pending") {
    await db
      .update(jobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
    return;
  }

  try {
    const result = await evaluateRecall({
      userId: job.userId,
      prompt: row.prompt,
      referenceAnswer: row.referenceAnswer,
      answer: row.answer,
      answerMode: row.mode,
    });
    if (result.confidence < 0.55) {
      await db
        .update(evaluations)
        .set({
          status: "failed",
          feedback: "The evaluator was uncertain. Please self-grade.",
          expectedAnswer: row.referenceAnswer,
          confidence: result.confidence,
          error: "Low confidence",
          completedAt: new Date(),
        })
        .where(eq(evaluations.id, evaluationId));
    } else {
      await db.transaction(async (tx) => {
        const [submission] = await tx
          .select({ status: answerSubmissions.status })
          .from(answerSubmissions)
          .where(eq(answerSubmissions.id, submissionId))
          .limit(1);
        if (!submission || submission.status !== "pending") {
          await tx
            .update(evaluations)
            .set({ status: "superseded", completedAt: new Date() })
            .where(eq(evaluations.id, evaluationId));
          return;
        }
        await tx
          .update(evaluations)
          .set({
            status: "complete",
            proposedGrade: result.grade,
            feedback: result.feedback,
            expectedAnswer: result.expectedAnswer,
            coveredPoints: result.coveredPoints,
            missingPoints: result.missingPoints,
            demonstratedGap: result.demonstratedGap,
            confidence: result.confidence,
            completedAt: new Date(),
          })
          .where(eq(evaluations.id, evaluationId));
        await applyGradeInTransaction(tx, {
          userId: job.userId,
          submissionId,
          grade: result.grade,
          origin: "model",
          evaluationId,
        });
        if (
          (result.grade === "again" || result.grade === "hard") &&
          result.demonstratedGap
        ) {
          const [{ count: repairsToday }] = await tx
            .select({ count: count() })
            .from(jobs)
            .where(
              and(
                eq(jobs.userId, job.userId),
                eq(jobs.type, "repair_gap"),
                sql`${jobs.createdAt} >= date_trunc('day', now())`,
              ),
            );
          if (repairsToday < 5) {
            await tx
              .insert(jobs)
              .values({
                userId: job.userId,
                type: "repair_gap",
                idempotencyKey: submissionId,
                priority: 2,
                payload: {
                  submissionId,
                  evaluationId,
                },
              })
              .onConflictDoNothing();
          }
        }
      });
    }
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        lockedUntil: null,
        result: { submissionId, evaluationId },
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = job.attempts;
    await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + attempts * 30_000),
        lockedUntil: null,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    if (attempts >= 3) {
      await db
        .update(evaluations)
        .set({
          status: "failed",
          feedback: "Evaluation failed. Please self-grade.",
          expectedAnswer: row.referenceAnswer,
          error: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
          completedAt: new Date(),
        })
        .where(eq(evaluations.id, evaluationId));
    }
    throw error;
  }
}

export async function runRepairJob(jobId: string): Promise<void> {
  const db = getV2Db();
  const job = await claimV2Job(jobId, "repair_gap");
  if (!job) {
    return;
  }
  const submissionId =
    typeof job.payload.submissionId === "string"
      ? job.payload.submissionId
      : "";
  const evaluationId =
    typeof job.payload.evaluationId === "string"
      ? job.payload.evaluationId
      : "";
  const [row] = await db
    .select({
      questionId: answerSubmissions.questionId,
      questionVersionId: answerSubmissions.questionVersionId,
      prompt: questionVersions.prompt,
      demonstratedGap: evaluations.demonstratedGap,
      evaluationStatus: evaluations.status,
    })
    .from(answerSubmissions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.userId, answerSubmissions.userId),
        eq(questionVersions.id, answerSubmissions.questionVersionId),
      ),
    )
    .innerJoin(
      evaluations,
      and(
        eq(evaluations.userId, answerSubmissions.userId),
        eq(evaluations.id, evaluationId),
      ),
    )
    .where(
      and(
        eq(answerSubmissions.userId, job.userId),
        eq(answerSubmissions.id, submissionId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.evaluationStatus !== "complete" ||
    !row.demonstratedGap
  ) {
    await db
      .update(jobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return;
  }
  const demonstratedGap = row.demonstratedGap;
  try {
    const evidence = await getQuestionEvidenceText(job.userId, row.questionId);
    if (!evidence) {
      throw new Error("The demonstrated gap has no usable supporting evidence.");
    }
    const proposed = await generateRepairQuestion({
      userId: job.userId,
      parentPrompt: row.prompt,
      demonstratedGap,
      evidence,
    });
    if (!proposed) {
      await db
        .update(jobs)
        .set({
          status: "succeeded",
          progress: 100,
          result: { submissionId, repairQuestionId: null },
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      return;
    }
    const quality = assessQuestionQuality({
      prompt: proposed.question,
      referenceAnswer: proposed.answer,
      target: proposed.target,
    });
    const targetKey = recallTargetKey(proposed.target);
    const repairQuestionId = await db.transaction(async (tx) => {
      const [effectiveGrade] = await tx
        .select({ value: gradeEvents.value })
        .from(gradeEvents)
        .where(
          and(
            eq(gradeEvents.userId, job.userId),
            eq(gradeEvents.submissionId, submissionId),
          ),
        )
        .orderBy(desc(gradeEvents.createdAt), desc(gradeEvents.id))
        .limit(1);
      if (
        !effectiveGrade ||
        (effectiveGrade.value !== "again" && effectiveGrade.value !== "hard")
      ) {
        return null;
      }
      const [existingRepair] = await tx
        .select({ childQuestionId: repairDrafts.childQuestionId })
        .from(repairDrafts)
        .where(
          and(
            eq(repairDrafts.userId, job.userId),
            eq(repairDrafts.submissionId, submissionId),
          ),
        )
        .limit(1);
      if (existingRepair) {
        return existingRepair.childQuestionId;
      }
      const [duplicate] = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.userId, job.userId),
            eq(questions.targetKey, targetKey),
            inArray(questions.lifecycle, ACTIVE_LIFECYCLES),
          ),
        )
        .limit(1);
      const [question] = await tx
        .insert(questions)
        .values({
          userId: job.userId,
          lifecycle: "draft",
          targetKey,
        })
        .returning({ id: questions.id });
      const [version] = await tx
        .insert(questionVersions)
        .values({
          userId: job.userId,
          questionId: question.id,
          version: 1,
          prompt: proposed.question,
          referenceAnswer: proposed.answer,
          displayAnswer: proposed.displayAnswer,
          mode: proposed.answerMode,
          targetText: proposed.target,
          quality: duplicate
            ? "duplicate"
            : quality.passes
              ? "pending"
              : "rejected",
          qualityReasons: duplicate
            ? ["An active question already covers this demonstrated gap."]
            : quality.reasons,
          duplicateOfQuestionId: duplicate?.id,
        })
        .returning({ id: questionVersions.id });
      const evidenceLinks = await tx
        .select({
          evidenceSpanId: questionEvidence.evidenceSpanId,
          requirement: questionEvidence.requirement,
        })
        .from(questionEvidence)
        .where(
          and(
            eq(questionEvidence.userId, job.userId),
            eq(questionEvidence.questionVersionId, row.questionVersionId),
          ),
        );
      if (evidenceLinks.length > 0) {
        await tx
          .insert(questionEvidence)
          .values(
            evidenceLinks.map((link) => ({
              userId: job.userId,
              questionVersionId: version.id,
              evidenceSpanId: link.evidenceSpanId,
              requirement: link.requirement,
            })),
          )
          .onConflictDoNothing();
      }
      const parentConcepts = await tx
        .select({ conceptId: questionConcepts.conceptId })
        .from(questionConcepts)
        .where(
          and(
            eq(questionConcepts.userId, job.userId),
            eq(questionConcepts.questionId, row.questionId),
          ),
        );
      if (parentConcepts.length > 0) {
        await tx
          .insert(questionConcepts)
          .values(
            parentConcepts.map((item) => ({
              userId: job.userId,
              questionId: question.id,
              conceptId: item.conceptId,
            })),
          )
          .onConflictDoNothing();
      }
      await tx.insert(questionRelations).values({
        userId: job.userId,
        fromQuestionId: question.id,
        toQuestionId: row.questionId,
        relation: "repair_for",
      });
      await tx.insert(repairDrafts).values({
        userId: job.userId,
        submissionId,
        parentQuestionId: row.questionId,
        childQuestionId: question.id,
        demonstratedGap,
      });
      if (!duplicate && quality.passes) {
        await tx.insert(jobs).values({
          userId: job.userId,
          type: "activate_question",
          idempotencyKey: version.id,
          priority: 1,
          payload: {
            questionId: question.id,
            questionVersionId: version.id,
          },
        });
      }
      return question.id;
    });
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        result: { submissionId, repairQuestionId },
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = job.attempts;
    await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + attempts * 30_000),
        lockedUntil: null,
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    throw error;
  }
}

export async function applyLearnerGrade(input: {
  userId: string;
  submissionId: string;
  grade: V2Grade;
}): Promise<V2Evaluation> {
  const db = getV2Db();
  const [submission] = await db
    .select({ status: answerSubmissions.status })
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, input.submissionId),
      ),
    )
    .limit(1);
  if (!submission) {
    throw new Error("Submission not found.");
  }
  await db.transaction(async (tx) => {
    if (submission.status === "pending") {
      await applyGradeInTransaction(tx, {
        userId: input.userId,
        submissionId: input.submissionId,
        grade: input.grade,
        origin: "self",
      });
      await tx
        .update(evaluations)
        .set({
          status: "superseded",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(evaluations.userId, input.userId),
            eq(evaluations.submissionId, input.submissionId),
            eq(evaluations.status, "pending"),
          ),
        );
      return;
    }
    const [fullSubmission] = await tx
      .select({
        questionId: answerSubmissions.questionId,
        itemId: answerSubmissions.sessionItemId,
      })
      .from(answerSubmissions)
      .where(
        and(
          eq(answerSubmissions.userId, input.userId),
          eq(answerSubmissions.id, input.submissionId),
        ),
      )
      .limit(1);
    if (!fullSubmission) {
      throw new Error("Submission not found.");
    }
    await tx.insert(gradeEvents).values({
      userId: input.userId,
      submissionId: input.submissionId,
      value: input.grade,
      origin: "correction",
    });
    const [mergeRedirect] = await tx
      .select({ questionId: questionRelations.toQuestionId })
      .from(questionRelations)
      .where(
        and(
          eq(questionRelations.userId, input.userId),
          eq(questionRelations.fromQuestionId, fullSubmission.questionId),
          eq(questionRelations.relation, "merged_into"),
        ),
      )
      .orderBy(desc(questionRelations.createdAt))
      .limit(1);
    const effectiveQuestionId =
      mergeRedirect?.questionId ?? fullSubmission.questionId;
    await rebuildQuestionMemoryInTransaction(tx, {
      userId: input.userId,
      questionId: effectiveQuestionId,
      sourceQuestionIds: mergeRedirect
        ? [effectiveQuestionId, fullSubmission.questionId]
        : undefined,
    });
    if (input.grade !== "again") {
      const obligations = await tx
        .select({
          sessionId: retryObligations.sessionId,
          questionId: retryObligations.questionId,
        })
        .from(retryObligations)
        .where(
          and(
            eq(retryObligations.userId, input.userId),
            eq(retryObligations.firstSubmissionId, input.submissionId),
            or(
              eq(retryObligations.status, "queued"),
              eq(retryObligations.status, "deferred"),
            ),
          ),
        );
      await tx
        .update(retryObligations)
        .set({
          status: "cancelled",
          reason: "The corrected grade no longer requires a retry.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(retryObligations.userId, input.userId),
            eq(retryObligations.firstSubmissionId, input.submissionId),
            or(
              eq(retryObligations.status, "queued"),
              eq(retryObligations.status, "deferred"),
            ),
          ),
        );
      for (const obligation of obligations) {
        await tx
          .update(reviewSessionItems)
          .set({ state: "invalidated" })
          .where(
            and(
              eq(reviewSessionItems.userId, input.userId),
              eq(reviewSessionItems.sessionId, obligation.sessionId),
              eq(reviewSessionItems.questionId, obligation.questionId),
              eq(reviewSessionItems.kind, "retry"),
              eq(reviewSessionItems.state, "queued"),
            ),
          );
      }
      if (input.grade === "good" || input.grade === "easy") {
        await tx
          .update(questions)
          .set({
            lifecycle: "trash",
            priorLifecycle: "draft",
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(questions.userId, input.userId),
              eq(questions.lifecycle, "draft"),
              sql`${questions.id} IN (
                SELECT rd.child_question_id
                  FROM waxon_v2.repair_drafts rd
                 WHERE rd.user_id = ${input.userId}
                   AND rd.submission_id = ${input.submissionId}
              )`,
            ),
          );
      }
    } else {
      const [item] = await tx
        .select()
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.id, fullSubmission.itemId),
          ),
        )
        .limit(1);
      if (item?.kind === "base") {
        const [existingObligation] = await tx
          .select()
          .from(retryObligations)
          .where(
            and(
              eq(retryObligations.userId, input.userId),
              eq(retryObligations.firstSubmissionId, input.submissionId),
            ),
          )
          .limit(1);
        if (
          !existingObligation ||
          ["cancelled", "deferred", "queued"].includes(existingObligation.status)
        ) {
          const [differentAfter] = await tx
            .select({ id: reviewSessionItems.id })
            .from(reviewSessionItems)
            .where(
              and(
                eq(reviewSessionItems.userId, input.userId),
                eq(reviewSessionItems.sessionId, item.sessionId),
                ne(reviewSessionItems.questionId, item.questionId),
                sql`${reviewSessionItems.position} > ${item.position}`,
                ne(reviewSessionItems.state, "invalidated"),
              ),
            )
            .limit(1);
          const earliestAt = retryEarliestAt({
            hasDifferentQuestionAfter: Boolean(differentAfter),
          });
          if (existingObligation) {
            await tx
              .update(retryObligations)
              .set({
                status: "queued",
                earliestAt,
                reason: "The corrected grade requires one retry.",
                updatedAt: new Date(),
              })
              .where(eq(retryObligations.id, existingObligation.id));
          } else {
            await tx.insert(retryObligations).values({
              userId: input.userId,
              firstSubmissionId: input.submissionId,
              questionId: item.questionId,
              questionVersionId: item.questionVersionId,
              sessionId: item.sessionId,
              earliestAt,
            });
          }
          const [retryItem] = await tx
            .select({ id: reviewSessionItems.id, state: reviewSessionItems.state })
            .from(reviewSessionItems)
            .where(
              and(
                eq(reviewSessionItems.userId, input.userId),
                eq(reviewSessionItems.sessionId, item.sessionId),
                eq(reviewSessionItems.questionId, item.questionId),
                eq(reviewSessionItems.kind, "retry"),
              ),
            )
            .limit(1);
          if (retryItem?.state === "invalidated") {
            await tx
              .update(reviewSessionItems)
              .set({ state: "queued", earliestAt })
              .where(eq(reviewSessionItems.id, retryItem.id));
          } else if (!retryItem) {
            const [maxPosition] = await tx
              .select({
                value: sql<number>`COALESCE(max(${reviewSessionItems.position}), -1)`,
              })
              .from(reviewSessionItems)
              .where(
                and(
                  eq(reviewSessionItems.userId, input.userId),
                  eq(reviewSessionItems.sessionId, item.sessionId),
                ),
              );
            await tx.insert(reviewSessionItems).values({
              userId: input.userId,
              sessionId: item.sessionId,
              questionId: item.questionId,
              questionVersionId: item.questionVersionId,
              kind: "retry",
              position: Number(maxPosition?.value ?? -1) + 1,
              earliestAt,
            });
          }
        }
      }
    }
  });

  return await getEvaluationForSubmission(input.userId, input.submissionId);
}

export async function acceptQuestion(input: {
  userId: string;
  questionId: string;
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        lifecycle: questions.lifecycle,
        quality: questionVersions.quality,
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
          eq(questions.id, input.questionId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new Error("Question not found.");
    }
    if (row.lifecycle !== "draft" || row.quality !== "distinct") {
      throw new Error(
        "This question must pass quality and duplicate checks before acceptance.",
      );
    }
    await tx
      .update(questions)
      .set({ lifecycle: "new", updatedAt: new Date() })
      .where(eq(questions.id, input.questionId));
    await tx
      .update(coverageTargets)
      .set({ status: "covered", updatedAt: new Date() })
      .where(
        and(
          eq(coverageTargets.userId, input.userId),
          sql`${coverageTargets.id} IN (
            SELECT tq.target_id
              FROM waxon_v2.target_questions tq
             WHERE tq.user_id = ${input.userId}
               AND tq.question_id = ${input.questionId}
          )`,
        ),
      );
  });
}

export async function acceptQuestions(input: {
  userId: string;
  questionIds: string[];
}): Promise<number> {
  const questionIds = [...new Set(input.questionIds)].slice(0, 50);
  if (questionIds.length === 0) {
    return 0;
  }
  const db = getV2Db();
  return await db.transaction(async (tx) => {
    const ready = await tx
      .select({ id: questions.id })
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
          inArray(questions.id, questionIds),
          eq(questions.lifecycle, "draft"),
          eq(questionVersions.quality, "distinct"),
        ),
      );
    const readyIds = ready.map((row) => row.id);
    if (readyIds.length === 0) {
      return 0;
    }
    await tx
      .update(questions)
      .set({ lifecycle: "new", updatedAt: new Date() })
      .where(
        and(
          eq(questions.userId, input.userId),
          inArray(questions.id, readyIds),
        ),
      );
    const targetRows = await tx
      .select({ id: targetQuestions.targetId })
      .from(targetQuestions)
      .where(
        and(
          eq(targetQuestions.userId, input.userId),
          inArray(targetQuestions.questionId, readyIds),
        ),
      );
    const targetIds = [...new Set(targetRows.map((row) => row.id))];
    if (targetIds.length > 0) {
      await tx
        .update(coverageTargets)
        .set({ status: "covered", updatedAt: new Date() })
        .where(
          and(
            eq(coverageTargets.userId, input.userId),
            inArray(coverageTargets.id, targetIds),
          ),
        );
    }
    return readyIds.length;
  });
}

export async function mutateQuestionLifecycle(input: {
  userId: string;
  questionId: string;
  action: "pause" | "archive" | "trash" | "restore" | "flag";
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [question] = await tx
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, input.questionId),
        ),
      )
      .limit(1);
    if (!question) {
      throw new Error("Question not found.");
    }
    const next: V2Lifecycle =
      input.action === "pause"
        ? "paused"
        : input.action === "archive"
          ? "archived"
          : input.action === "trash"
            ? "trash"
            : input.action === "flag"
              ? "suspended"
              : question.priorLifecycle &&
                  ACTIVE_LIFECYCLES.includes(
                    question.priorLifecycle as V2Lifecycle,
                  )
                ? (question.priorLifecycle as V2Lifecycle)
                : "new";
    await tx
      .update(questions)
      .set({
        lifecycle: next,
        priorLifecycle:
          input.action === "restore" ? null : question.lifecycle,
        suspensionReason:
          input.action === "flag"
            ? "Quality needs review."
            : input.action === "restore"
              ? null
              : question.suspensionReason,
        deletedAt: input.action === "trash" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(questions.id, input.questionId));

    if (["pause", "archive", "trash"].includes(input.action)) {
      await tx
        .update(retryObligations)
        .set({
          status: "waived",
          reason: `Learner requested ${input.action}.`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(retryObligations.userId, input.userId),
            eq(retryObligations.questionId, input.questionId),
            or(
              eq(retryObligations.status, "queued"),
              eq(retryObligations.status, "deferred"),
            ),
          ),
        );
    } else if (input.action === "flag") {
      await tx
        .update(retryObligations)
        .set({
          status: "deferred",
          reason: "Question quality needs review.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(retryObligations.userId, input.userId),
            eq(retryObligations.questionId, input.questionId),
            eq(retryObligations.status, "queued"),
          ),
        );
    }
    await tx
      .update(reviewSessionItems)
      .set({ state: "invalidated" })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, input.questionId),
          eq(reviewSessionItems.state, "queued"),
        ),
      );
    if (input.action === "restore") {
      await tx
        .update(memoryStates)
        .set({ dueAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memoryStates.userId, input.userId),
            eq(memoryStates.questionId, input.questionId),
            sql`EXISTS (
              SELECT 1
                FROM waxon_v2.retry_obligations ro
               WHERE ro.user_id = ${input.userId}
                 AND ro.question_id = ${input.questionId}
                 AND ro.status = 'waived'
            )`,
          ),
        );
    }
  });
}

export async function editQuestion(input: {
  userId: string;
  questionId: string;
  prompt: string;
  referenceAnswer: string;
  displayAnswer?: string;
  target: string;
  answerMode: V2AnswerMode;
}): Promise<{ jobId: string | null; targetChanged: boolean }> {
  const db = getV2Db();
  const current = await currentQuestionVersion(input.userId, input.questionId);
  if (!current) {
    throw new Error("Question not found.");
  }
  const prompt = input.prompt.trim();
  const referenceAnswer = input.referenceAnswer.trim();
  const target = input.target.trim();
  const displayAnswer =
    input.displayAnswer?.trim() || referenceAnswer.slice(0, 8_000);
  const quality = assessQuestionQuality({ prompt, referenceAnswer, target });
  const targetKey = recallTargetKey(target);
  const targetChanged = targetKey !== current.targetKey;
  const needsActivation = targetChanged || current.lifecycle === "draft";

  return await db.transaction(async (tx) => {
    await tx
      .update(questionVersions)
      .set({ isCurrent: false })
      .where(
        and(
          eq(questionVersions.userId, input.userId),
          eq(questionVersions.id, current.versionId),
        ),
      );
    const [version] = await tx
      .insert(questionVersions)
      .values({
        userId: input.userId,
        questionId: input.questionId,
        version: current.version + 1,
        prompt,
        referenceAnswer,
        displayAnswer,
        mode: input.answerMode,
        targetText: target,
        quality: quality.passes
          ? needsActivation
            ? "pending"
            : "distinct"
          : "rejected",
        qualityReasons: quality.reasons,
        learnerAttested: true,
      })
      .returning({ id: questionVersions.id });
    const evidence = await tx
      .select({
        evidenceSpanId: questionEvidence.evidenceSpanId,
        requirement: questionEvidence.requirement,
      })
      .from(questionEvidence)
      .where(
        and(
          eq(questionEvidence.userId, input.userId),
          eq(questionEvidence.questionVersionId, current.versionId),
        ),
      );
    if (evidence.length > 0) {
      await tx
        .insert(questionEvidence)
        .values(
          evidence.map((item) => ({
            userId: input.userId,
            questionVersionId: version.id,
            evidenceSpanId: item.evidenceSpanId,
            requirement: item.requirement,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(questions)
      .set({
        targetKey,
        lifecycle: quality.passes
          ? needsActivation
            ? "draft"
            : current.lifecycle
          : "draft",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, input.questionId),
        ),
      );
    if (targetChanged) {
      await tx
        .delete(memoryStates)
        .where(
          and(
            eq(memoryStates.userId, input.userId),
            eq(memoryStates.questionId, input.questionId),
          ),
        );
      await tx
        .update(reviewSessionItems)
        .set({ state: "invalidated" })
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.questionId, input.questionId),
            eq(reviewSessionItems.state, "queued"),
          ),
        );
    }
    let jobId: string | null = null;
    if (quality.passes && needsActivation) {
      const [job] = await tx
        .insert(jobs)
        .values({
          userId: input.userId,
          type: "activate_question",
          idempotencyKey: version.id,
          priority: 1,
          payload: {
            questionId: input.questionId,
            questionVersionId: version.id,
          },
        })
        .returning({ id: jobs.id });
      jobId = job.id;
    }
    return { jobId, targetChanged };
  });
}

export async function splitQuestion(input: {
  userId: string;
  questionId: string;
  children: Array<{
    prompt: string;
    referenceAnswer: string;
    displayAnswer?: string;
    target: string;
    answerMode: V2AnswerMode;
  }>;
}): Promise<{ childQuestionIds: string[] }> {
  if (input.children.length < 2 || input.children.length > 12) {
    throw new Error("A split must create between 2 and 12 questions.");
  }
  const parent = await currentQuestionVersion(input.userId, input.questionId);
  if (!parent) {
    throw new Error("Question not found.");
  }
  const childQuestionIds: string[] = [];
  for (const [index, child] of input.children.entries()) {
    const result = await createDirectQuestion({
      userId: input.userId,
      idempotencyKey: `split:${input.questionId}:${index}:${checksum(
        JSON.stringify(child),
      )}`,
      ...child,
    });
    childQuestionIds.push(result.questionId);
  }
  const db = getV2Db();
  await db.transaction(async (tx) => {
    await tx
      .update(questions)
      .set({ lifecycle: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, input.questionId),
        ),
      );
    await tx.insert(questionRelations).values(
      childQuestionIds.map((childQuestionId) => ({
        userId: input.userId,
        fromQuestionId: input.questionId,
        toQuestionId: childQuestionId,
        relation: "split_into",
      })),
    );
    await tx
      .update(reviewSessionItems)
      .set({ state: "invalidated" })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, input.questionId),
          eq(reviewSessionItems.state, "queued"),
        ),
      );
  });
  return { childQuestionIds };
}

export async function mergeQuestions(input: {
  userId: string;
  canonicalQuestionId: string;
  redundantQuestionId: string;
}): Promise<void> {
  if (input.canonicalQuestionId === input.redundantQuestionId) {
    throw new Error("Choose two different questions.");
  }
  const db = getV2Db();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`activation:${input.userId}`}))`,
    );
    const rows = await tx
      .select({
        questionId: questions.id,
        targetKey: questions.targetKey,
        lifecycle: questions.lifecycle,
        versionId: questionVersions.id,
        version: questionVersions.version,
        prompt: questionVersions.prompt,
        referenceAnswer: questionVersions.referenceAnswer,
        displayAnswer: questionVersions.displayAnswer,
        mode: questionVersions.mode,
        targetText: questionVersions.targetText,
        learnerAttested: questionVersions.learnerAttested,
        duplicateOfQuestionId: questionVersions.duplicateOfQuestionId,
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
          inArray(questions.id, [
            input.canonicalQuestionId,
            input.redundantQuestionId,
          ]),
        ),
      );
    if (rows.length !== 2) {
      throw new Error("Both questions must exist.");
    }
    const canonical = rows.find(
      (row) => row.questionId === input.canonicalQuestionId,
    );
    const redundant = rows.find(
      (row) => row.questionId === input.redundantQuestionId,
    );
    if (!canonical || !redundant) {
      throw new Error("Could not resolve merge questions.");
    }
    const explicitlyMatched =
      canonical.targetKey === redundant.targetKey ||
      canonical.duplicateOfQuestionId === redundant.questionId ||
      redundant.duplicateOfQuestionId === canonical.questionId;
    if (!explicitlyMatched) {
      throw new Error(
        "These questions do not test the same verified atomic recall target.",
      );
    }
    await tx
      .update(questions)
      .set({ lifecycle: "superseded", updatedAt: new Date() })
      .where(eq(questions.id, redundant.questionId));
    await tx
      .update(questionVersions)
      .set({ isCurrent: false })
      .where(eq(questionVersions.id, canonical.versionId));
    const [newVersion] = await tx
      .insert(questionVersions)
      .values({
        userId: input.userId,
        questionId: canonical.questionId,
        version: canonical.version + 1,
        prompt: canonical.prompt,
        referenceAnswer: canonical.referenceAnswer,
        displayAnswer: canonical.displayAnswer,
        mode: canonical.mode,
        targetText: canonical.targetText,
        quality: "distinct",
        learnerAttested: canonical.learnerAttested,
      })
      .returning({ id: questionVersions.id });
    const evidence = await tx
      .select({
        evidenceSpanId: questionEvidence.evidenceSpanId,
        requirement: questionEvidence.requirement,
      })
      .from(questionEvidence)
      .where(
        and(
          eq(questionEvidence.userId, input.userId),
          inArray(questionEvidence.questionVersionId, [
            canonical.versionId,
            redundant.versionId,
          ]),
        ),
      );
    if (evidence.length > 0) {
      await tx
        .insert(questionEvidence)
        .values(
          evidence.map((item) => ({
            userId: input.userId,
            questionVersionId: newVersion.id,
            evidenceSpanId: item.evidenceSpanId,
            requirement: item.requirement,
          })),
        )
        .onConflictDoNothing();
    }
    const redundantConcepts = await tx
      .select({ conceptId: questionConcepts.conceptId })
      .from(questionConcepts)
      .where(
        and(
          eq(questionConcepts.userId, input.userId),
          eq(questionConcepts.questionId, redundant.questionId),
        ),
      );
    if (redundantConcepts.length > 0) {
      await tx
        .insert(questionConcepts)
        .values(
          redundantConcepts.map((item) => ({
            userId: input.userId,
            questionId: canonical.questionId,
            conceptId: item.conceptId,
          })),
        )
        .onConflictDoNothing();
    }
    await tx.insert(questionRelations).values({
      userId: input.userId,
      fromQuestionId: redundant.questionId,
      toQuestionId: canonical.questionId,
      relation: "merged_into",
    });
    await tx
      .update(answerSubmissions)
      .set({ questionId: canonical.questionId })
      .where(
        and(
          eq(answerSubmissions.userId, input.userId),
          eq(answerSubmissions.questionId, redundant.questionId),
          eq(answerSubmissions.status, "pending"),
        ),
      );
    await tx
      .update(retryObligations)
      .set({
        questionId: canonical.questionId,
        questionVersionId: newVersion.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.questionId, redundant.questionId),
          or(
            eq(retryObligations.status, "queued"),
            eq(retryObligations.status, "deferred"),
          ),
        ),
      );
    await tx
      .update(reviewSessionItems)
      .set({
        questionId: canonical.questionId,
        questionVersionId: newVersion.id,
      })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, redundant.questionId),
          eq(reviewSessionItems.kind, "retry"),
          eq(reviewSessionItems.state, "queued"),
        ),
      );
    await tx
      .update(reviewSessionItems)
      .set({ questionId: canonical.questionId })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, redundant.questionId),
          eq(reviewSessionItems.state, "exposed"),
        ),
      );
    await tx
      .update(reviewSessionItems)
      .set({ state: "invalidated" })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, redundant.questionId),
          eq(reviewSessionItems.kind, "base"),
          eq(reviewSessionItems.state, "queued"),
        ),
      );
    await rebuildQuestionMemoryInTransaction(tx, {
      userId: input.userId,
      questionId: canonical.questionId,
      sourceQuestionIds: [canonical.questionId, redundant.questionId],
    });
    await tx
      .delete(memoryStates)
      .where(
        and(
          eq(memoryStates.userId, input.userId),
          eq(memoryStates.questionId, redundant.questionId),
        ),
      );
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
        lte(jobs.runAfter, new Date()),
      ),
    )
    .orderBy(asc(jobs.priority), asc(jobs.createdAt))
    .limit(Math.max(1, Math.min(20, input.limit ?? 5)));
  let processed = 0;
  for (const job of pending) {
    try {
      if (job.type === "activate_question") {
        await runActivationJob(job.id);
      } else if (job.type === "evaluate_submission") {
        await runEvaluationJob(job.id);
      } else if (job.type === "repair_gap") {
        await runRepairJob(job.id);
      } else {
        continue;
      }
      processed += 1;
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          waxon_version: "v2",
          job_type: job.type,
        },
        extra: { jobId: job.id },
      });
      // The job owns retry state and its visible error.
    }
  }
  return processed;
}

export async function addConceptToQuestion(input: {
  userId: string;
  questionId: string;
  name: string;
}): Promise<void> {
  const name = input.name.trim().slice(0, 120);
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 120);
  if (!name || !slug) {
    throw new Error("Concept name is required.");
  }
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [concept] = await tx
      .insert(concepts)
      .values({ userId: input.userId, name, slug })
      .onConflictDoUpdate({
        target: [concepts.userId, concepts.slug],
        set: { name, updatedAt: new Date() },
      })
      .returning({ id: concepts.id });
    await tx
      .insert(questionConcepts)
      .values({
        userId: input.userId,
        questionId: input.questionId,
        conceptId: concept.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(conceptAliases)
      .values({
        userId: input.userId,
        conceptId: concept.id,
        alias: name.toLocaleLowerCase("und"),
      })
      .onConflictDoNothing();
  });
}

export async function getQuestionEvidenceText(
  userId: string,
  questionId: string,
): Promise<string> {
  const db = getV2Db();
  const rows = await db
    .select({ quote: evidenceSpans.quote })
    .from(questions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.userId, questions.userId),
        eq(questionVersions.questionId, questions.id),
        eq(questionVersions.isCurrent, true),
      ),
    )
    .innerJoin(
      questionEvidence,
      and(
        eq(questionEvidence.userId, questionVersions.userId),
        eq(questionEvidence.questionVersionId, questionVersions.id),
      ),
    )
    .innerJoin(
      evidenceSpans,
      and(
        eq(evidenceSpans.userId, questionEvidence.userId),
        eq(evidenceSpans.id, questionEvidence.evidenceSpanId),
      ),
    )
    .where(and(eq(questions.userId, userId), eq(questions.id, questionId)))
    .limit(8);

  return rows.map((row) => row.quote).join("\n\n");
}
