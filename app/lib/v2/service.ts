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
import { getV2Client, getV2Db } from "../../db/v2/client.ts";
import {
  answerSubmissions,
  evaluations,
  gradeEvents,
  jobs,
  learnerSettings,
  memoryStates,
  mutationReceipts,
  questionVersions,
  questions,
  retryObligations,
  reviewSessionItems,
  reviewSessions,
} from "../../db/v2/schema.ts";
import { buildReviewPlan, type PlanCandidate } from "./planner.ts";
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
import {
  applyFsrsGrade,
  memoryRetrievability,
  SCHEDULER_VERSION,
  type StoredMemoryState,
} from "./scheduler.ts";
import type {
  V2Evaluation,
  V2Grade,
  V2LibraryResponse,
  V2Lifecycle,
  V2QuestionLifecycle,
  V2Question,
  V2ReviewItem,
  V2ReviewSessionResponse,
  V2ReviewSummary,
} from "./types.ts";
import { evaluateRecall } from "./model.ts";
import { claimV2Job } from "./jobs.ts";
import { runQuestionEmbeddingJob } from "./questionEmbeddings.ts";
import { retryEarliestAt } from "./retryPolicy.ts";

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
const SESSION_ITEM_INSERT_BATCH = 500;

type V2Tx = Parameters<
  Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]
>[0];

export type AddQuestionResult = {
  id: string;
  status: "created" | "existing";
  lifecycle: V2QuestionLifecycle;
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
  const [created] = await db
    .insert(learnerSettings)
    .values({ userId })
    .onConflictDoNothing({ target: learnerSettings.userId })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);
  if (!existing) throw new Error("Could not load learner settings.");
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

type ReviewDayBounds = {
  start: Date;
  end: Date;
};

async function reviewDayBounds(
  timezone: string,
  now = defaultV2ServiceDependencies.now(),
): Promise<ReviewDayBounds> {
  const [row] = await getV2Client().pool
    .query<{ day_start: Date; day_end: Date }>(
      `SELECT
         date_trunc('day', $2::timestamptz AT TIME ZONE $1) AT TIME ZONE $1 AS day_start,
         (date_trunc('day', $2::timestamptz AT TIME ZONE $1) + interval '1 day')
           AT TIME ZONE $1 AS day_end`,
      [timezone, now],
    )
    .then((result) => result.rows);
  if (!row) throw new Error("Could not determine the learner's review day.");
  return { start: row.day_start, end: row.day_end };
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
  const items = await Promise.all(
    input.items.map(async (item) => {
      const normalized = normalizeQuestionInput(item, { passes: true, reasons: [] });
      const assessment = await dependencies.validateQuestion({
        prompt: normalized.prompt,
        referenceAnswer: normalized.referenceAnswer,
        target: normalized.prompt,
      });
      return normalizeQuestionInput(item, assessment);
    }),
  );
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
      })),
    };
  }

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

    for (const item of items) {
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
        });
        continue;
      }
      const [question] = await tx
        .insert(questions)
        .values({
          userId: input.userId,
          lifecycle: "new",
          targetKey: item.promptKey,
          importance: item.importance,
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
      const created: AddQuestionResult = {
        id: question.id,
        status: "created",
        lifecycle: "active",
      };
      results.push(created);
      createdQuestionIds.push(question.id);
      byPromptKey.set(item.promptKey, {
        id: question.id,
        lifecycle: "new",
        targetKey: item.promptKey,
        referenceAnswer: item.referenceAnswer,
      });
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
    importance?: number;
  },
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<{
  questionId: string;
  lifecycle: V2QuestionLifecycle;
  status: "created" | "existing";
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
  };
}

export async function listLibrary(input: {
  userId: string;
  search?: string;
  lifecycle?: V2QuestionLifecycle | "all";
  limit?: number;
}, now = defaultV2ServiceDependencies.now()): Promise<V2LibraryResponse> {
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
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT q.id, qv.id AS version_id, qv.prompt, qv.reference_answer,
            q.lifecycle::text, q.importance, ms.due_at,
            ms.stability, ms.difficulty, ms.last_review_at, ms.elapsed_days,
            ms.scheduled_days, ms.reps, ms.lapses, ms.state AS memory_state,
            ms.learning_steps, q.created_at, q.updated_at
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
  const settings = await getLearnerSettings(input.userId);
  const questionsOut: V2Question[] = rows.rows.map((row) => {
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
        ? storedMemory({
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
          })
        : null;
    return {
      id: row.id,
      versionId: row.version_id,
      prompt: row.prompt,
      referenceAnswer: row.reference_answer,
      lifecycle: questionLifecycle(row.lifecycle),
      importance: Number(row.importance),
      dueAt: row.due_at?.toISOString() ?? null,
      retrievability: memory
          ? memoryRetrievability({
              memory,
              desiredRetention: settings.desiredRetention,
              at: now,
            })
        : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
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

async function planCandidates(
  userId: string,
  day: ReviewDayBounds,
): Promise<PlanCandidate[]> {
  const db = getV2Db();
  const rows = await db
    .select({
      questionId: questions.id,
      questionVersionId: questionVersions.id,
      lifecycle: questions.lifecycle,
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
        sql`NOT EXISTS (
          SELECT 1 FROM waxon_v2.answer_submissions pending
           WHERE pending.user_id = ${questions.userId}
             AND pending.question_id = ${questions.id}
             AND pending.question_version_id = ${questionVersions.id}
             AND pending.status = 'pending'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM waxon_v2.answer_submissions reviewed_today
           WHERE reviewed_today.user_id = ${questions.userId}
             AND reviewed_today.question_id = ${questions.id}
             AND reviewed_today.question_version_id = ${questionVersions.id}
             AND reviewed_today.status = 'graded'
             AND reviewed_today.submitted_at >= ${day.start}
             AND reviewed_today.submitted_at < ${day.end}
        )`,
      ),
    )
    .orderBy(asc(memoryStates.dueAt), asc(questions.createdAt));
  const settings = await getLearnerSettings(userId);
  return rows.map((row) => {
    const memory = row.memory?.dueAt ? storedMemory(row.memory) : null;
    return {
      questionId: row.questionId,
      questionVersionId: row.questionVersionId,
      lifecycle: row.lifecycle as V2Lifecycle,
      dueAt: row.dueAt,
      retrievability: memory
        ? memoryRetrievability({
            memory,
            desiredRetention: settings.desiredRetention,
            at: day.end,
          })
        : null,
      importance: row.importance,
      createdAt: row.createdAt,
    };
  });
}

async function reviewCapacity(
  userId: string,
  settings: typeof learnerSettings.$inferSelect,
  day: ReviewDayBounds,
) {
  const [row] = await getV2Client().pool
    .query<{
      at_risk: string;
      waiting_new: string;
      oldest_new_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE q.lifecycle::text IN ('learning','review')
             AND ms.due_at < $3
             AND NOT EXISTS (
               SELECT 1 FROM waxon_v2.answer_submissions reviewed_today
               WHERE reviewed_today.user_id = q.user_id
                  AND reviewed_today.question_id = q.id
                  AND reviewed_today.question_version_id = qv.id
                  AND reviewed_today.status = 'graded'
                  AND reviewed_today.submitted_at >= $2
                  AND reviewed_today.submitted_at < $3
             )
         )::text AS at_risk,
         count(*) FILTER (WHERE q.lifecycle::text = 'new')::text AS waiting_new,
         min(q.created_at) FILTER (WHERE q.lifecycle::text = 'new') AS oldest_new_at
       FROM waxon_v2.questions q
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id
        AND qv.question_id = q.id
        AND qv.is_current = true
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1`,
      [userId, day.start, day.end],
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
    minutesNeeded: Math.max(settings.dailyMinutes, Math.ceil((atRiskCount * 120) / 60)),
    atRiskCount,
    waitingNew: Number(row?.waiting_new ?? 0),
    oldestNewAt: row?.oldest_new_at?.toISOString() ?? null,
  };
}

async function exposeNextItem(
  userId: string,
  sessionId: string,
  now: Date,
): Promise<V2ReviewItem | null> {
  const db = getV2Db();
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-item:${userId}`}))`,
    );
    const fields = {
      itemId: reviewSessionItems.id,
      questionId: reviewSessionItems.questionId,
      questionVersionId: reviewSessionItems.questionVersionId,
      prompt: questionVersions.prompt,
      position: reviewSessionItems.position,
      kind: reviewSessionItems.kind,
    };
    const [exposed] = await tx
      .select(fields)
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
    const [queued] = exposed
      ? []
      : await tx
          .select(fields)
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
          .limit(1);
    const row = exposed ?? queued;
    if (!row) return null;

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
      await tx
        .update(questions)
        .set({ lifecycle: "learning", updatedAt: now })
        .where(
          and(
            eq(questions.userId, userId),
            eq(questions.id, row.questionId),
            eq(questions.lifecycle, "new"),
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
      position: row.position,
      total: itemCount,
      estimatedMinutes: Math.max(1, Math.ceil((session?.estimatedSeconds ?? 60) / 60)),
      isRetry: row.kind === "retry",
    };
  });
}

export async function getOrCreateReviewSession(
  userId: string,
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<V2ReviewSessionResponse> {
  const db = getV2Db();
  const now = dependencies.now();
  const settings = await getLearnerSettings(userId);
  const day = await reviewDayBounds(settings.timezone, now);
  const plan = buildReviewPlan({
    candidates: await planCandidates(userId, day),
    desiredRetention: settings.desiredRetention,
    scheduledBefore: day.end,
    now,
  });
  let session: typeof reviewSessions.$inferSelect | undefined = (
    await db
    .select()
    .from(reviewSessions)
    .where(and(eq(reviewSessions.userId, userId), eq(reviewSessions.status, "active")))
    .limit(1)
  )[0];

  if (!session) {
    if (plan.length > 0) {
      session = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`session:${userId}`}))`,
        );
        const [existing] = await tx
          .select()
          .from(reviewSessions)
          .where(
            and(eq(reviewSessions.userId, userId), eq(reviewSessions.status, "active")),
          )
          .limit(1);
        if (existing) return existing;
        const [created] = await tx
          .insert(reviewSessions)
          .values({
            userId,
            timeBudgetMinutes: settings.dailyMinutes,
            desiredRetention: settings.desiredRetention,
            estimatedSeconds: plan.reduce((sum, item) => sum + item.estimatedSeconds, 0),
            reservedSeconds: plan.reduce((sum, item) => sum + item.estimatedSeconds * 2, 0),
            plannedCount: plan.length,
          })
          .returning();
        const earliestAt = now;
        for (let offset = 0; offset < plan.length; offset += SESSION_ITEM_INSERT_BATCH) {
          await tx.insert(reviewSessionItems).values(
            plan.slice(offset, offset + SESSION_ITEM_INSERT_BATCH).map((item) => ({
              userId,
              sessionId: created.id,
              questionId: item.questionId,
              questionVersionId: item.questionVersionId,
              position: item.position,
              earliestAt,
              estimatedSeconds: item.estimatedSeconds,
              isIntroduction: item.dueAt === null,
            })),
          );
        }
        return created;
      });
    }
  }

  if (session && plan.length > 0) {
    const sessionId = session.id;
    const synchronizedSession = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`session:${userId}`}))`,
      );
      const [active] = await tx
        .select()
        .from(reviewSessions)
        .where(
          and(
            eq(reviewSessions.userId, userId),
            eq(reviewSessions.id, sessionId),
            eq(reviewSessions.status, "active"),
          ),
        )
        .limit(1);
      if (!active) return null;
      const existing = await tx
        .select({ questionVersionId: reviewSessionItems.questionVersionId })
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, userId),
            eq(reviewSessionItems.sessionId, active.id),
            eq(reviewSessionItems.kind, "base"),
          ),
        );
      const existingVersions = new Set(existing.map((item) => item.questionVersionId));
      const missing = plan.filter(
        (item) => !existingVersions.has(item.questionVersionId),
      );
      if (missing.length === 0) return active;
      const [lastPosition] = await tx
        .select({ value: sql<number>`COALESCE(max(${reviewSessionItems.position}), -1)` })
        .from(reviewSessionItems)
        .where(
          and(
            eq(reviewSessionItems.userId, userId),
            eq(reviewSessionItems.sessionId, active.id),
          ),
        );
      const firstPosition = Number(lastPosition?.value ?? -1) + 1;
      const earliestAt = now;
      for (let offset = 0; offset < missing.length; offset += SESSION_ITEM_INSERT_BATCH) {
        await tx.insert(reviewSessionItems).values(
          missing
            .slice(offset, offset + SESSION_ITEM_INSERT_BATCH)
            .map((item, index) => ({
              userId,
              sessionId: active.id,
              questionId: item.questionId,
              questionVersionId: item.questionVersionId,
              position: firstPosition + offset + index,
              earliestAt,
              estimatedSeconds: item.estimatedSeconds,
              isIntroduction: item.dueAt === null,
            })),
        );
      }
      const addedSeconds = missing.reduce(
        (sum, item) => sum + item.estimatedSeconds,
        0,
      );
      const [updated] = await tx
        .update(reviewSessions)
        .set({
          plannedCount: sql`${reviewSessions.plannedCount} + ${missing.length}`,
          estimatedSeconds: sql`${reviewSessions.estimatedSeconds} + ${addedSeconds}`,
          reservedSeconds: sql`${reviewSessions.reservedSeconds} + ${addedSeconds * 2}`,
          updatedAt: now,
        })
        .where(eq(reviewSessions.id, active.id))
        .returning();
      return updated ?? active;
    });
    session = synchronizedSession ?? undefined;
  }

  let item = session ? await exposeNextItem(userId, session.id, now) : null;
  if (session && !item) {
    const [{ unfinished }] = await db
      .select({ unfinished: count() })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, session.id),
          inArray(reviewSessionItems.state, ["queued", "exposed", "submitted"]),
        ),
      );
    if (unfinished === 0) {
      await db
        .update(reviewSessions)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(eq(reviewSessions.id, session.id));
      session = undefined;
      item = null;
    }
  }

  const summary = await getReviewSummary(userId, now);
  const capacity = await reviewCapacity(userId, settings, day);
  let completedCount = 0;
  let plannedCount = 0;
  let retryAvailableAt: string | null = null;
  let waitingOnEvaluation = false;
  if (session) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, session.id),
          ne(reviewSessionItems.state, "invalidated"),
        ),
      );
    plannedCount = total;
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
    const [{ pending }] = await db
      .select({ pending: count() })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, userId),
          eq(reviewSessionItems.sessionId, session.id),
          eq(reviewSessionItems.state, "submitted"),
        ),
      );
    waitingOnEvaluation = pending > 0;
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
          plannedCount,
          estimatedMinutes: Math.max(1, Math.ceil(session.estimatedSeconds / 60)),
          completedCount,
        }
      : null,
    item,
    retryAvailableAt,
    waitingOnEvaluation,
    blockedReason: null,
    summary,
    capacity,
  };
}

export async function actOnReviewItem(input: {
  userId: string;
  itemId: string;
  action: "flag" | "next";
}, dependencies: V2ServiceDependencies = defaultV2ServiceDependencies): Promise<V2ReviewSessionResponse> {
  const db = getV2Db();
  const now = dependencies.now();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-item:${input.userId}`}))`,
    );
    if (input.action === "flag") {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`question-bank:${input.userId}`}))`,
      );
    }
    const [item] = await tx
      .select()
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.id, input.itemId),
          eq(reviewSessionItems.state, "exposed"),
          sql`EXISTS (
            SELECT 1 FROM waxon_v2.review_sessions active_session
             WHERE active_session.user_id = ${input.userId}
               AND active_session.id = ${reviewSessionItems.sessionId}
               AND active_session.status = 'active'
          )`,
        ),
      )
      .limit(1);
    if (!item) throw new Error("Review item is no longer current.");

    if (input.action === "next") {
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
      await tx
        .update(reviewSessionItems)
        .set({
          state: "queued",
          position: Number(maxPosition?.value ?? -1) + 1,
          exposedAt: null,
        })
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.id, item.id),
            eq(reviewSessionItems.state, "exposed"),
          ),
        );
      if (item.kind === "retry") {
        await tx
          .update(retryObligations)
          .set({ status: "queued", updatedAt: now })
          .where(
            and(
              eq(retryObligations.userId, input.userId),
              eq(retryObligations.sessionId, item.sessionId),
              eq(retryObligations.questionId, item.questionId),
              eq(retryObligations.status, "exposed"),
            ),
          );
      }
      return;
    }

    const [question] = await tx
      .select({ lifecycle: questions.lifecycle })
      .from(questions)
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, item.questionId),
        ),
      )
      .limit(1);
    if (
      !question ||
      !ACTIVE_LIFECYCLES.includes(question.lifecycle as V2Lifecycle)
    ) {
      throw new Error("Question is no longer available in Review.");
    }
    const priorLifecycle: V2Lifecycle = item.isIntroduction
      ? "new"
      : (question.lifecycle as V2Lifecycle);
    await tx
      .update(questions)
      .set({
        lifecycle: "flagged",
        priorLifecycle,
        suspensionReason: "Flagged during Review.",
        deletedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, item.questionId),
        ),
      );
    await tx
      .update(retryObligations)
      .set({
        status: "waived",
        reason: "Learner flagged the question for later review.",
        updatedAt: now,
      })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.questionId, item.questionId),
          inArray(retryObligations.status, ["queued", "deferred", "exposed"]),
        ),
      );
    await tx
      .update(reviewSessionItems)
      .set({ state: "invalidated" })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, item.questionId),
          inArray(reviewSessionItems.state, ["queued", "exposed"]),
        ),
      );
  });
  return await getOrCreateReviewSession(input.userId, dependencies);
}

export async function getReviewSummary(
  userId: string,
  now = defaultV2ServiceDependencies.now(),
): Promise<V2ReviewSummary> {
  const settings = await getLearnerSettings(userId);
  const day = await reviewDayBounds(settings.timezone, now);
  const [active] = await getV2Client().pool
    .query<{ due_count: string }>(
      `SELECT count(item.id) FILTER (
                WHERE item.state::text IN ('queued','exposed','submitted')
              )::text AS due_count
         FROM waxon_v2.review_sessions session
         LEFT JOIN waxon_v2.review_session_items item
           ON item.user_id = session.user_id AND item.session_id = session.id
        WHERE session.user_id = $1
          AND session.status = 'active'
        GROUP BY session.id
        LIMIT 1`,
      [userId],
    )
    .then((result) => result.rows);
  const queueRemaining = active
    ? Number(active.due_count)
    : buildReviewPlan({
        candidates: await planCandidates(userId, day),
        desiredRetention: settings.desiredRetention,
        scheduledBefore: day.end,
      }).length;
  const [row] = await getV2Client().pool
    .query<{ next_due: Date | null }>(
      `SELECT min(candidate.effective_due) FILTER (
                WHERE candidate.effective_due > $4
              ) AS next_due
         FROM (
           SELECT CASE
                    WHEN EXISTS (
                      SELECT 1 FROM waxon_v2.answer_submissions reviewed_today
                       WHERE reviewed_today.user_id = q.user_id
                         AND reviewed_today.question_id = q.id
                         AND reviewed_today.question_version_id = qv.id
                         AND reviewed_today.status = 'graded'
                         AND reviewed_today.submitted_at >= $2
                         AND reviewed_today.submitted_at < $3
                    ) THEN GREATEST(ms.due_at, $3)
                    ELSE ms.due_at
                  END AS effective_due
             FROM waxon_v2.questions q
             JOIN waxon_v2.question_versions qv
               ON qv.user_id = q.user_id
              AND qv.question_id = q.id
              AND qv.is_current = true
             JOIN waxon_v2.memory_states ms
               ON ms.user_id = q.user_id AND ms.question_id = q.id
            WHERE q.user_id = $1
              AND q.lifecycle::text IN ('learning','review')
              AND NOT EXISTS (
                SELECT 1 FROM waxon_v2.answer_submissions pending
                 WHERE pending.user_id = q.user_id
                   AND pending.question_id = q.id
                   AND pending.question_version_id = qv.id
                   AND pending.status = 'pending'
              )
         ) candidate`,
      [userId, day.start, day.end, now],
    )
    .then((result) => result.rows);
  return {
    queueRemaining,
    nextScheduledDue: row?.next_due?.getTime() ?? null,
  };
}

async function createRetryIfNeeded(
  tx: V2Tx,
  input: {
    userId: string;
    submissionId: string;
    grade: V2Grade;
    item: typeof reviewSessionItems.$inferSelect;
  },
  now: Date,
): Promise<void> {
  if (input.item.kind === "retry") {
    await tx
      .update(retryObligations)
      .set({ status: "completed", updatedAt: now })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.sessionId, input.item.sessionId),
          eq(retryObligations.questionId, input.item.questionId),
          eq(retryObligations.status, "exposed"),
        ),
      );
    return;
  }
  const [obligation] = await tx
    .select()
    .from(retryObligations)
    .where(
      and(
        eq(retryObligations.userId, input.userId),
        eq(retryObligations.firstSubmissionId, input.submissionId),
      ),
    )
    .limit(1);

  if (input.grade !== "again") {
    if (obligation && ["queued", "deferred", "exposed"].includes(obligation.status)) {
      await tx
        .update(retryObligations)
        .set({
          status: "cancelled",
          reason: "The effective first grade no longer requires a retry.",
          updatedAt: now,
        })
        .where(eq(retryObligations.id, obligation.id));
      await tx
        .update(reviewSessionItems)
        .set({ state: "invalidated" })
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.sessionId, input.item.sessionId),
            eq(reviewSessionItems.questionId, input.item.questionId),
            eq(reviewSessionItems.kind, "retry"),
            inArray(reviewSessionItems.state, ["queued", "exposed"]),
          ),
        );
    }
    return;
  }
  if (obligation && !["cancelled", "deferred", "queued"].includes(obligation.status)) {
    return;
  }
  const [differentAfter] = await tx
    .select({ id: reviewSessionItems.id })
    .from(reviewSessionItems)
    .where(
      and(
        eq(reviewSessionItems.userId, input.userId),
        eq(reviewSessionItems.sessionId, input.item.sessionId),
        ne(reviewSessionItems.questionId, input.item.questionId),
        sql`${reviewSessionItems.position} > ${input.item.position}`,
        ne(reviewSessionItems.state, "invalidated"),
      ),
    )
    .limit(1);
  const earliestAt = retryEarliestAt({
    hasDifferentQuestionAfter: Boolean(differentAfter),
    now,
  });
  if (obligation) {
    await tx
      .update(retryObligations)
      .set({ status: "queued", earliestAt, reason: null, updatedAt: now })
      .where(eq(retryObligations.id, obligation.id));
  } else {
    await tx.insert(retryObligations).values({
      userId: input.userId,
      firstSubmissionId: input.submissionId,
      questionId: input.item.questionId,
      questionVersionId: input.item.questionVersionId,
      sessionId: input.item.sessionId,
      earliestAt,
    });
  }
  const [retryItem] = await tx
    .select({ id: reviewSessionItems.id, state: reviewSessionItems.state })
    .from(reviewSessionItems)
    .where(
      and(
        eq(reviewSessionItems.userId, input.userId),
        eq(reviewSessionItems.sessionId, input.item.sessionId),
        eq(reviewSessionItems.questionId, input.item.questionId),
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
      .select({ value: sql<number>`COALESCE(max(${reviewSessionItems.position}), -1)` })
      .from(reviewSessionItems)
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.sessionId, input.item.sessionId),
        ),
      );
    await tx.insert(reviewSessionItems).values({
      userId: input.userId,
      sessionId: input.item.sessionId,
      questionId: input.item.questionId,
      questionVersionId: input.item.questionVersionId,
      kind: "retry",
      position: Number(maxPosition?.value ?? -1) + 1,
      earliestAt,
      estimatedSeconds: input.item.estimatedSeconds,
    });
  }
}

async function applyGradeInTransaction(
  tx: V2Tx,
  input: {
    userId: string;
    submissionId: string;
    grade: V2Grade;
    origin: "deterministic" | "model" | "self" | "correction";
    evaluationId?: string | null;
  },
  now: Date,
): Promise<void> {
  const [submission] = await tx
    .select()
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, input.submissionId),
      ),
    )
    .limit(1);
  if (!submission) throw new Error("Submission not found.");
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
  if (!item) throw new Error("Review item not found.");
  const [settings] = await tx
    .select({ desiredRetention: learnerSettings.desiredRetention })
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
    now: submission.submittedAt,
  });
  await tx.insert(gradeEvents).values({
    userId: input.userId,
    submissionId: input.submissionId,
    value: input.grade,
    origin: input.origin,
    evaluationId: input.evaluationId ?? null,
    createdAt: now,
  });
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
        updatedAt: now,
      },
    });
  await tx
    .update(answerSubmissions)
    .set({ status: "graded" })
    .where(eq(answerSubmissions.id, submission.id));
  await tx
    .update(reviewSessionItems)
    .set({ state: "evaluated" })
    .where(eq(reviewSessionItems.id, item.id));
  await tx
    .update(questions)
    .set({ lifecycle: "review", updatedAt: now })
    .where(and(eq(questions.userId, input.userId), eq(questions.id, submission.questionId)));
  if (item.kind === "base" && input.grade !== "again") {
    await tx
      .update(reviewSessions)
      .set({
        reservedSeconds: sql`GREATEST(0, ${reviewSessions.reservedSeconds} - ${item.estimatedSeconds})`,
        updatedAt: now,
      })
      .where(eq(reviewSessions.id, item.sessionId));
  }
  await createRetryIfNeeded(tx, {
    userId: input.userId,
    submissionId: input.submissionId,
    grade: input.grade,
    item,
  }, now);
}

async function rebuildQuestionMemoryInTransaction(
  tx: V2Tx,
  input: { userId: string; questionId: string },
  now: Date,
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
        eq(answerSubmissions.questionId, input.questionId),
        eq(answerSubmissions.status, "graded"),
      ),
    )
    .orderBy(asc(answerSubmissions.submittedAt), asc(gradeEvents.createdAt), asc(gradeEvents.id));
  const latestBySubmission = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latestBySubmission.set(row.submissionId, row);
  const effective = [...latestBySubmission.values()].sort(
    (left, right) =>
      left.submittedAt.getTime() - right.submittedAt.getTime() ||
      left.eventCreatedAt.getTime() - right.eventCreatedAt.getTime(),
  );
  let memory: StoredMemoryState | null = null;
  let priorReviewAt = 0;
  for (const row of effective) {
    const reviewAt = new Date(Math.max(row.submittedAt.getTime(), priorReviewAt + 1));
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
        updatedAt: now,
      },
    });
}

export async function submitReviewAnswer(
  input: {
    userId: string;
    itemId: string;
    answer: string;
  },
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<V2Evaluation> {
  const now = dependencies.now();
  const submissionId = await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-item:${input.userId}`}))`,
    );
    const [item] = await tx
      .select({
        id: reviewSessionItems.id,
        questionId: reviewSessionItems.questionId,
        questionVersionId: reviewSessionItems.questionVersionId,
        state: reviewSessionItems.state,
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
      if (existing) return existing.id;
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

    const [evaluation] = await tx
      .insert(evaluations)
      .values({ userId: input.userId, submissionId: submission.id, evaluator: "model" })
      .returning({ id: evaluations.id });
    await tx.insert(jobs).values({
      userId: input.userId,
      type: "evaluate_submission",
      idempotencyKey: submission.id,
      priority: 0,
      payload: { submissionId: submission.id, evaluationId: evaluation.id },
    });
    return submission.id;
  });
  return await getEvaluationForSubmission(input.userId, submissionId);
}

export async function getEvaluationForSubmission(
  userId: string,
  submissionId: string,
): Promise<V2Evaluation> {
  const db = getV2Db();
  const [row] = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.userId, userId), eq(evaluations.submissionId, submissionId)))
    .orderBy(desc(evaluations.createdAt))
    .limit(1);
  if (!row) throw new Error("Evaluation not found.");
  const [effectiveGrade] = await db
    .select({ value: gradeEvents.value })
    .from(gradeEvents)
    .where(and(eq(gradeEvents.userId, userId), eq(gradeEvents.submissionId, submissionId)))
    .orderBy(desc(gradeEvents.createdAt), desc(gradeEvents.id))
    .limit(1);
  const grade = effectiveGrade?.value ?? row.proposedGrade;
  const status =
    row.status === "complete" || effectiveGrade
      ? "complete"
      : row.status === "failed"
        ? "failed"
        : "pending";
  let nextDueAt: string | null = null;
  if (status === "complete" && grade) {
    const [schedule] = await db
      .select({ dueAt: memoryStates.dueAt })
      .from(answerSubmissions)
      .leftJoin(
        memoryStates,
        and(
          eq(memoryStates.userId, answerSubmissions.userId),
          eq(memoryStates.questionId, answerSubmissions.questionId),
        ),
      )
      .where(
        and(
          eq(answerSubmissions.userId, userId),
          eq(answerSubmissions.id, submissionId),
        ),
      )
      .limit(1);
    nextDueAt = schedule?.dueAt?.toISOString() ?? null;
  }
  return {
    submissionId,
    evaluationId: row.id,
    status,
    grade,
    nextDueAt,
    feedback: row.feedback,
    expectedAnswer: row.expectedAnswer,
    coveredPoints: row.coveredPoints,
    missingPoints: row.missingPoints,
    demonstratedGap: row.demonstratedGap,
    confidence: row.confidence,
    canSelfGrade: true,
  };
}

export async function runEvaluationJob(
  jobId: string,
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<void> {
  const db = getV2Db();
  const now = dependencies.now();
  const job = await claimV2Job(jobId, "evaluate_submission", now);
  if (!job) return;
  const submissionId = typeof job.payload.submissionId === "string" ? job.payload.submissionId : "";
  const evaluationId = typeof job.payload.evaluationId === "string" ? job.payload.evaluationId : "";
  const [row] = await db
    .select({
      submissionStatus: answerSubmissions.status,
      answer: answerSubmissions.answer,
      prompt: questionVersions.prompt,
      referenceAnswer: questionVersions.referenceAnswer,
    })
    .from(answerSubmissions)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.userId, answerSubmissions.userId),
        eq(questionVersions.id, answerSubmissions.questionVersionId),
      ),
    )
    .where(and(eq(answerSubmissions.userId, job.userId), eq(answerSubmissions.id, submissionId)))
    .limit(1);
  if (!row || row.submissionStatus !== "pending") {
    await db.update(jobs).set({ status: "cancelled", updatedAt: now }).where(eq(jobs.id, jobId));
    return;
  }
  try {
    const result = await dependencies.evaluateAnswer({
      userId: job.userId,
      prompt: row.prompt,
      referenceAnswer: row.referenceAnswer,
      answer: row.answer,
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
          completedAt: now,
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
            .set({ status: "superseded", completedAt: now })
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
            completedAt: now,
          })
          .where(eq(evaluations.id, evaluationId));
        await applyGradeInTransaction(tx, {
          userId: job.userId,
          submissionId,
          grade: result.grade,
          origin: "model",
          evaluationId,
        }, now);
      });
    }
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        lockedUntil: null,
        result: { submissionId, evaluationId },
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = job.attempts;
    await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(now.getTime() + attempts * 30_000),
        lockedUntil: null,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: now,
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
          completedAt: now,
        })
        .where(eq(evaluations.id, evaluationId));
    }
    throw error;
  }
}

export async function runEvaluationForSubmission(
  userId: string,
  submissionId: string,
  dependencies: V2ServiceDependencies = defaultV2ServiceDependencies,
): Promise<V2Evaluation> {
  const [job] = await getV2Db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.type, "evaluate_submission"),
        eq(jobs.idempotencyKey, submissionId),
      ),
    )
    .limit(1);
  if (!job) throw new Error("Evaluation job not found.");
  await runEvaluationJob(job.id, dependencies);
  return getEvaluationForSubmission(userId, submissionId);
}

export async function applyLearnerGrade(input: {
  userId: string;
  submissionId: string;
  grade: V2Grade;
}, dependencies: V2ServiceDependencies = defaultV2ServiceDependencies): Promise<V2Evaluation> {
  const db = getV2Db();
  const now = dependencies.now();
  const [submission] = await db
    .select()
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, input.submissionId),
      ),
    )
    .limit(1);
  if (!submission) throw new Error("Submission not found.");
  await db.transaction(async (tx) => {
    if (submission.status === "pending") {
      await applyGradeInTransaction(tx, {
        userId: input.userId,
        submissionId: input.submissionId,
        grade: input.grade,
        origin: "self",
      }, now);
      await tx
        .update(evaluations)
        .set({ status: "superseded", completedAt: now })
        .where(
          and(
            eq(evaluations.userId, input.userId),
            eq(evaluations.submissionId, input.submissionId),
            eq(evaluations.status, "pending"),
          ),
        );
      return;
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
    if (!item) throw new Error("Review item not found.");
    await tx.insert(gradeEvents).values({
      userId: input.userId,
      submissionId: input.submissionId,
      value: input.grade,
      origin: "correction",
      createdAt: now,
    });
    await rebuildQuestionMemoryInTransaction(tx, {
      userId: input.userId,
      questionId: submission.questionId,
    }, now);
    await createRetryIfNeeded(tx, {
      userId: input.userId,
      submissionId: input.submissionId,
      grade: input.grade,
      item,
    }, now);
  });
  return await getEvaluationForSubmission(input.userId, input.submissionId);
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
    if (input.action === "archive") {
      await tx
        .update(retryObligations)
        .set({
          status: "waived",
          reason: "Learner archived the Question.",
          updatedAt: now,
        })
        .where(
          and(
            eq(retryObligations.userId, input.userId),
            eq(retryObligations.questionId, input.questionId),
            inArray(retryObligations.status, ["queued", "deferred", "exposed"]),
          ),
        );
      await tx
        .update(reviewSessionItems)
        .set({ state: "invalidated" })
        .where(
          and(
            eq(reviewSessionItems.userId, input.userId),
            eq(reviewSessionItems.questionId, input.questionId),
            inArray(reviewSessionItems.state, ["queued", "exposed"]),
          ),
        );
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
        importance: questions.importance,
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
    const [replacement] = await tx
      .insert(questions)
      .values({
        userId: input.userId,
        lifecycle: "new",
        targetKey: normalized.promptKey,
        importance: current.importance,
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
    await tx
      .update(reviewSessionItems)
      .set({ state: "invalidated" })
      .where(
        and(
          eq(reviewSessionItems.userId, input.userId),
          eq(reviewSessionItems.questionId, input.questionId),
          inArray(reviewSessionItems.state, ["queued", "exposed"]),
        ),
      );
    await tx
      .update(retryObligations)
      .set({ status: "waived", reason: "Question replaced.", updatedAt: now })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.questionId, input.questionId),
          inArray(retryObligations.status, ["queued", "deferred", "exposed"]),
        ),
      );
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
        await runEvaluationJob(job.id);
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
