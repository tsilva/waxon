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
} from "@/app/db/v2/schema";
import { buildReviewPlan, type PlanCandidate } from "./planner";
import {
  MAX_QUESTION_BATCH,
  normalizeQuestionInput,
  questionPromptKey,
  type LeanQuestionInput,
  type NormalizedQuestionInput,
} from "./questionInput";
import { normalizeExactAnswer } from "./questionQuality";
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
} from "./types";
import { evaluateRecall } from "./model";
import { claimV2Job } from "./jobs";
import { retryEarliestAt } from "./retryPolicy";

const ACTIVE_LIFECYCLES: V2Lifecycle[] = ["new", "learning", "review"];
const ALL_LIFECYCLES: V2Lifecycle[] = [
  "new",
  "learning",
  "review",
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
  lifecycle: V2Lifecycle;
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

export async function addQuestions(input: {
  userId: string;
  idempotencyKey: string;
  items: LeanQuestionInput[];
  scope?: "library" | "mcp";
}): Promise<{ results: AddQuestionResult[] }> {
  if (input.items.length === 0 || input.items.length > MAX_QUESTION_BATCH) {
    throw new Error(`Add between 1 and ${MAX_QUESTION_BATCH} questions at a time.`);
  }
  const items = input.items.map(normalizeQuestionInput);
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
  if (prior) return prior;

  return await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-add:${input.userId}`}))`,
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
      return receipt.response as { results: AddQuestionResult[] };
    }

    const existing = await tx
      .select({
        id: questions.id,
        lifecycle: questions.lifecycle,
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
      .where(eq(questions.userId, input.userId));
    const requestedPromptKeys = new Set(items.map((item) => item.promptKey));
    const byPromptKey = new Map(
      existing
        .map((row) => [questionPromptKey(row.prompt), row] as const)
        .filter(([key]) => requestedPromptKeys.has(key)),
    );
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

    for (const item of items) {
      const duplicate = byPromptKey.get(item.promptKey);
      if (duplicate) {
        if (duplicate.referenceAnswer.trim() !== item.referenceAnswer) {
          throw new Error(
            `“${item.prompt.slice(0, 120)}” already exists with a different reference answer. Edit the existing question instead.`,
          );
        }
        results.push({
          id: duplicate.id,
          status: "existing",
          lifecycle: ALL_LIFECYCLES.includes(duplicate.lifecycle as V2Lifecycle)
            ? (duplicate.lifecycle as V2Lifecycle)
            : "paused",
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
        mode: item.answerMode,
      });
      const created: AddQuestionResult = {
        id: question.id,
        status: "created",
        lifecycle: "new",
      };
      results.push(created);
      byPromptKey.set(item.promptKey, {
        id: question.id,
        lifecycle: "new",
        prompt: item.prompt,
        referenceAnswer: item.referenceAnswer,
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

export async function createDirectQuestion(input: {
  userId: string;
  idempotencyKey: string;
  prompt: string;
  referenceAnswer: string;
  answerMode: V2AnswerMode;
  importance?: number;
}): Promise<{
  questionId: string;
  lifecycle: V2Lifecycle;
  status: "created" | "existing";
}> {
  const { results } = await addQuestions({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    items: [input],
  });
  const result = results[0];
  return {
    questionId: result.id,
    lifecycle: result.lifecycle,
    status: result.status,
  };
}

async function currentQuestionVersion(userId: string, questionId: string) {
  const [row] = await getV2Db()
    .select({
      questionId: questions.id,
      lifecycle: questions.lifecycle,
      priorLifecycle: questions.priorLifecycle,
      importance: questions.importance,
      versionId: questionVersions.id,
      version: questionVersions.version,
      prompt: questionVersions.prompt,
      referenceAnswer: questionVersions.referenceAnswer,
      mode: questionVersions.mode,
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
    .where(and(eq(questions.userId, userId), eq(questions.id, questionId)))
    .limit(1);
  return row ?? null;
}

export async function listLibrary(input: {
  userId: string;
  search?: string;
  lifecycle?: V2Lifecycle | "all";
  limit?: number;
}): Promise<V2LibraryResponse> {
  const limit = Math.max(1, Math.min(QUESTION_PAGE_LIMIT, input.limit ?? 100));
  const search = input.search?.trim() ?? "";
  const lifecycle =
    input.lifecycle && input.lifecycle !== "all" ? input.lifecycle : null;
  const pool = getV2Client().pool;
  const rows = await pool.query<{
    id: string;
    version_id: string;
    prompt: string;
    reference_answer: string;
    answer_mode: V2AnswerMode;
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
            qv.answer_mode, q.lifecycle::text, q.importance, ms.due_at,
            ms.stability, ms.difficulty, ms.last_review_at, ms.elapsed_days,
            ms.scheduled_days, ms.reps, ms.lapses, ms.state AS memory_state,
            ms.learning_steps, q.created_at, q.updated_at
       FROM waxon_v2.questions q
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id AND qv.question_id = q.id AND qv.is_current = true
       LEFT JOIN waxon_v2.memory_states ms
         ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1
        AND ($2::text IS NULL OR q.lifecycle::text = $2)
        AND ($3 = '' OR qv.prompt ILIKE '%' || $3 || '%' OR qv.reference_answer ILIKE '%' || $3 || '%')
        AND q.lifecycle::text IN ('new','learning','review','paused','archived','trash')
      ORDER BY q.updated_at DESC, q.id
      LIMIT $4`,
    [input.userId, lifecycle, search, limit],
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
      answerMode: row.answer_mode,
      lifecycle: row.lifecycle as V2Lifecycle,
      importance: Number(row.importance),
      dueAt: row.due_at?.toISOString() ?? null,
      retrievability: memory
        ? memoryRetrievability({
            memory,
            desiredRetention: settings.desiredRetention,
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
        AND lifecycle::text IN ('new','learning','review','paused','archived','trash')
      GROUP BY lifecycle`,
    [input.userId],
  );
  const counts = Object.fromEntries(
    ALL_LIFECYCLES.map((value) => [value, 0]),
  ) as Record<V2Lifecycle, number>;
  for (const row of countRows.rows) {
    if (ALL_LIFECYCLES.includes(row.lifecycle as V2Lifecycle)) {
      counts[row.lifecycle as V2Lifecycle] = Number(row.count);
    }
  }
  return { questions: questionsOut, counts, waitingNew: counts.new };
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
    const memory = row.memory?.dueAt ? storedMemory(row.memory) : null;
    return {
      questionId: row.questionId,
      questionVersionId: row.questionVersionId,
      lifecycle: row.lifecycle as V2Lifecycle,
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
      createdAt: row.createdAt,
    };
  });
}

async function reviewCapacity(userId: string) {
  const settings = await getLearnerSettings(userId);
  const [row] = await getV2Client().pool
    .query<{
      at_risk: string;
      waiting_new: string;
      oldest_new_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE q.lifecycle::text IN ('learning','review')
             AND ms.due_at <= now() + interval '24 hours'
         )::text AS at_risk,
         count(*) FILTER (WHERE q.lifecycle::text = 'new')::text AS waiting_new,
         min(q.created_at) FILTER (WHERE q.lifecycle::text = 'new') AS oldest_new_at
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
    minutesNeeded: Math.max(settings.dailyMinutes, Math.ceil((atRiskCount * 120) / 60)),
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
    const fields = {
      itemId: reviewSessionItems.id,
      questionId: reviewSessionItems.questionId,
      questionVersionId: reviewSessionItems.questionVersionId,
      prompt: questionVersions.prompt,
      answerMode: questionVersions.mode,
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
      answerMode: row.answerMode,
      position: row.position,
      total: itemCount,
      estimatedMinutes: Math.max(1, Math.ceil((session?.estimatedSeconds ?? 60) / 60)),
      isRetry: row.kind === "retry",
    };
  });
}

export async function getOrCreateReviewSession(
  userId: string,
): Promise<V2ReviewSessionResponse> {
  const db = getV2Db();
  const settings = await getLearnerSettings(userId);
  let session: typeof reviewSessions.$inferSelect | undefined = (
    await db
    .select()
    .from(reviewSessions)
    .where(and(eq(reviewSessions.userId, userId), eq(reviewSessions.status, "active")))
    .limit(1)
  )[0];

  if (!session) {
    const plan = buildReviewPlan({
      candidates: await planCandidates(userId),
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
        await tx.insert(reviewSessionItems).values(
          plan.map((item) => ({
            userId,
            sessionId: created.id,
            questionId: item.questionId,
            questionVersionId: item.questionVersionId,
            position: item.position,
            earliestAt: new Date(),
            estimatedSeconds: item.estimatedSeconds,
            isIntroduction: item.lifecycle === "new",
          })),
        );
        return created;
      });
    }
  }

  let item = session ? await exposeNextItem(userId, session.id) : null;
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
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(reviewSessions.id, session.id));
      session = undefined;
      item = null;
    }
  }

  const summary = await getReviewSummary(userId);
  const capacity = await reviewCapacity(userId);
  let completedCount = 0;
  let retryAvailableAt: string | null = null;
  let waitingOnEvaluation = false;
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
          plannedCount: session.plannedCount,
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

export async function getReviewSummary(userId: string): Promise<V2ReviewSummary> {
  const [row] = await getV2Client().pool
    .query<{ due_count: string; next_due: Date | null }>(
      `SELECT count(*) FILTER (
                WHERE q.lifecycle::text IN ('learning','review')
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

async function createRetryIfNeeded(
  tx: V2Tx,
  input: {
    userId: string;
    submissionId: string;
    grade: V2Grade;
    item: typeof reviewSessionItems.$inferSelect;
  },
): Promise<void> {
  if (input.item.kind === "retry") {
    await tx
      .update(retryObligations)
      .set({ status: "completed", updatedAt: new Date() })
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
          updatedAt: new Date(),
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
  const earliestAt = retryEarliestAt({ hasDifferentQuestionAfter: Boolean(differentAfter) });
  if (obligation) {
    await tx
      .update(retryObligations)
      .set({ status: "queued", earliestAt, reason: null, updatedAt: new Date() })
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
        updatedAt: new Date(),
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
    .set({ lifecycle: "review", updatedAt: new Date() })
    .where(and(eq(questions.userId, input.userId), eq(questions.id, submission.questionId)));
  if (item.kind === "base" && input.grade !== "again") {
    await tx
      .update(reviewSessions)
      .set({
        reservedSeconds: sql`GREATEST(0, ${reviewSessions.reservedSeconds} - ${item.estimatedSeconds})`,
        updatedAt: new Date(),
      })
      .where(eq(reviewSessions.id, item.sessionId));
  }
  await createRetryIfNeeded(tx, {
    userId: input.userId,
    submissionId: input.submissionId,
    grade: input.grade,
    item,
  });
}

async function rebuildQuestionMemoryInTransaction(
  tx: V2Tx,
  input: { userId: string; questionId: string },
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
        updatedAt: new Date(),
      },
    });
}

export async function submitReviewAnswer(input: {
  userId: string;
  itemId: string;
  answer: string;
}): Promise<V2Evaluation> {
  const now = new Date();
  const submissionId = await getV2Db().transaction(async (tx) => {
    const [item] = await tx
      .select({
        id: reviewSessionItems.id,
        questionId: reviewSessionItems.questionId,
        questionVersionId: reviewSessionItems.questionVersionId,
        state: reviewSessionItems.state,
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
          feedback: matched ? "Correct." : "Your answer did not match the stored exact answer.",
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
    } else {
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
    }
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
  if (!job) return;
  const submissionId = typeof job.payload.submissionId === "string" ? job.payload.submissionId : "";
  const evaluationId = typeof job.payload.evaluationId === "string" ? job.payload.evaluationId : "";
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
    .where(and(eq(answerSubmissions.userId, job.userId), eq(answerSubmissions.id, submissionId)))
    .limit(1);
  if (!row || row.submissionStatus !== "pending") {
    await db.update(jobs).set({ status: "cancelled", updatedAt: new Date() }).where(eq(jobs.id, jobId));
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

export async function applyLearnerGrade(input: {
  userId: string;
  submissionId: string;
  grade: V2Grade;
}): Promise<V2Evaluation> {
  const db = getV2Db();
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
      });
      await tx
        .update(evaluations)
        .set({ status: "superseded", completedAt: new Date() })
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
    });
    await rebuildQuestionMemoryInTransaction(tx, {
      userId: input.userId,
      questionId: submission.questionId,
    });
    await createRetryIfNeeded(tx, {
      userId: input.userId,
      submissionId: input.submissionId,
      grade: input.grade,
      item,
    });
  });
  return await getEvaluationForSubmission(input.userId, input.submissionId);
}

export async function mutateQuestionLifecycle(input: {
  userId: string;
  questionId: string;
  action: "pause" | "archive" | "trash" | "restore";
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [question] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)))
      .limit(1);
    if (!question) throw new Error("Question not found.");
    const previous = ALL_LIFECYCLES.includes(question.lifecycle as V2Lifecycle)
      ? (question.lifecycle as V2Lifecycle)
      : "paused";
    const restored =
      question.priorLifecycle && ACTIVE_LIFECYCLES.includes(question.priorLifecycle as V2Lifecycle)
        ? (question.priorLifecycle as V2Lifecycle)
        : "new";
    const next: V2Lifecycle =
      input.action === "pause"
        ? "paused"
        : input.action === "archive"
          ? "archived"
          : input.action === "trash"
            ? "trash"
            : restored;
    await tx
      .update(questions)
      .set({
        lifecycle: next,
        priorLifecycle: input.action === "restore" ? null : previous,
        suspensionReason: null,
        deletedAt: input.action === "trash" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(questions.id, input.questionId));
    if (input.action !== "restore") {
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
    } else {
      await tx
        .update(memoryStates)
        .set({ dueAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memoryStates.userId, input.userId),
            eq(memoryStates.questionId, input.questionId),
            sql`EXISTS (
              SELECT 1 FROM waxon_v2.retry_obligations ro
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
  answerMode: V2AnswerMode;
  importance?: number;
}): Promise<{ resetScheduling: true }> {
  const normalized = normalizeQuestionInput(input);
  const current = await currentQuestionVersion(input.userId, input.questionId);
  if (!current) throw new Error("Question not found.");
  await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`question-edit:${input.userId}`}))`,
    );
    const possibleDuplicates = await tx
      .select({ id: questions.id, prompt: questionVersions.prompt })
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
          ne(questions.id, input.questionId),
        ),
      );
    const duplicate = possibleDuplicates.find(
      (candidate) => questionPromptKey(candidate.prompt) === normalized.promptKey,
    );
    if (duplicate) throw new Error("Another question already uses this prompt.");
    await tx
      .update(questionVersions)
      .set({ isCurrent: false })
      .where(eq(questionVersions.id, current.versionId));
    await tx.insert(questionVersions).values({
      userId: input.userId,
      questionId: input.questionId,
      version: current.version + 1,
      prompt: normalized.prompt,
      referenceAnswer: normalized.referenceAnswer,
      displayAnswer: normalized.referenceAnswer.slice(0, 8_000),
      mode: normalized.answerMode,
    });
    const lifecycle = ACTIVE_LIFECYCLES.includes(current.lifecycle as V2Lifecycle)
      ? "new"
      : (current.lifecycle as V2Lifecycle);
    await tx
      .update(questions)
      .set({
        targetKey: normalized.promptKey,
        importance: normalized.importance,
        lifecycle,
        updatedAt: new Date(),
      })
      .where(and(eq(questions.userId, input.userId), eq(questions.id, input.questionId)));
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
          inArray(reviewSessionItems.state, ["queued", "exposed"]),
        ),
      );
    await tx
      .update(retryObligations)
      .set({ status: "waived", reason: "Question edited.", updatedAt: new Date() })
      .where(
        and(
          eq(retryObligations.userId, input.userId),
          eq(retryObligations.questionId, input.questionId),
          inArray(retryObligations.status, ["queued", "deferred", "exposed"]),
        ),
      );
  });
  return { resetScheduling: true };
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
        eq(jobs.type, "evaluate_submission"),
        lte(jobs.runAfter, new Date()),
      ),
    )
    .orderBy(asc(jobs.priority), asc(jobs.createdAt))
    .limit(Math.max(1, Math.min(20, input.limit ?? 5)));
  let processed = 0;
  for (const job of pending) {
    try {
      await runEvaluationJob(job.id);
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
