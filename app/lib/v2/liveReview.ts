import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  sql,
} from "drizzle-orm";
import { getV2Client, getV2Db } from "../../db/v2/client.ts";
import {
  answerSubmissions,
  evaluations,
  gradeEvents,
  jobs,
  memoryStates,
  mutationReceipts,
  questionFlags,
  questions,
  learnerSettings,
} from "../../db/v2/schema.ts";
import { claimV2Job } from "./jobs.ts";
import { authorizeBrowserAcceptanceEvaluation } from "../browserSmokeSupport.ts";
import { evaluateRecall } from "./model.ts";
import {
  applyFsrsGrade,
  SCHEDULER_VERSION,
  type StoredMemoryState,
} from "./scheduler.ts";
import {
  dateInTimezone,
  getLearnerReviewDay,
} from "./settings.ts";
import { normalizeReviewFlagInput } from "./reviewFlag.ts";
import { reconcileRecallEvaluation } from "./recallEvaluation.ts";
import type {
  V2Evaluation,
  V2Grade,
  V2QuestionFlag,
  V2ReviewQueueResponse,
  V2ReviewSummary,
} from "./types.ts";

type ReviewDependencies = {
  now(): Date;
  evaluateAnswer: typeof evaluateRecall;
};

export const defaultReviewDependencies: ReviewDependencies = {
  now: () => new Date(),
  evaluateAnswer: evaluateRecall,
};

type V2Tx = Parameters<
  Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]
>[0];

async function learnerReviewDayInTransaction(
  tx: V2Tx,
  userId: string,
  now: Date,
): Promise<{ effectiveTimezone: string; localDay: string }> {
  await tx
    .insert(learnerSettings)
    .values({ userId })
    .onConflictDoNothing({ target: learnerSettings.userId });
  const [settings] = await tx
    .select({ timezone: learnerSettings.timezone })
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);
  if (!settings) throw new Error("Could not load learner settings.");
  const effectiveTimezone = settings.timezone ?? "UTC";
  return {
    effectiveTimezone,
    localDay: dateInTimezone(now, effectiveTimezone),
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evaluationView(input: {
  submissionId: string;
  evaluationId: string;
  evaluationStatus: string;
  proposedGrade: V2Grade | null;
  effectiveGrade: V2Grade | null;
  dueOn: string | null;
  feedback: string | null;
  expectedAnswer: string | null;
  coveredPoints: string[];
  missingPoints: string[];
  demonstratedGap: string | null;
  confidence: number | null;
}): V2Evaluation {
  const grade = input.effectiveGrade ?? input.proposedGrade;
  return {
    submissionId: input.submissionId,
    evaluationId: input.evaluationId,
    status:
      input.evaluationStatus === "complete" || input.effectiveGrade
        ? "complete"
        : input.evaluationStatus === "failed"
          ? "failed"
          : "pending",
    grade,
    nextDueOn: grade ? input.dueOn : null,
    feedback: input.feedback,
    expectedAnswer: input.expectedAnswer,
    coveredPoints: input.coveredPoints,
    missingPoints: input.missingPoints,
    demonstratedGap: input.demonstratedGap,
    confidence: input.confidence,
    canSelfGrade:
      input.evaluationStatus === "failed" && !input.effectiveGrade,
    canCorrectGrade: Boolean(input.effectiveGrade),
  };
}

function activeQuestionEligibility(localDay: string) {
  return and(
    eq(questions.lifecycle, "active"),
    sql`(${memoryStates.questionId} IS NULL OR ${memoryStates.dueOn} <= ${localDay}::date)`,
    sql`NOT EXISTS (
      SELECT 1 FROM waxon_v2.answer_submissions pending
       WHERE pending.user_id = ${questions.userId}
         AND pending.question_id = ${questions.id}
         AND pending.status = 'pending'
    )`,
  );
}

async function queueRows(
  userId: string,
  localDay: string,
  database: Pick<ReturnType<typeof getV2Db>, "select"> = getV2Db(),
) {
  const latestEffectiveGrade = sql`(
    SELECT event.grade::text
      FROM waxon_v2.answer_submissions submission
      JOIN waxon_v2.grade_events event
        ON event.user_id = submission.user_id
       AND event.submission_id = submission.id
     WHERE submission.user_id = ${questions.userId}
       AND submission.question_id = ${questions.id}
     ORDER BY submission.submitted_at DESC,
              submission.created_at DESC,
              submission.id DESC,
              event.created_at DESC,
              event.id DESC
     LIMIT 1
  )`;
  return database
    .select({
      questionId: questions.id,
      prompt: questions.prompt,
      scheduledFor: memoryStates.dueOn,
    })
    .from(questions)
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
        activeQuestionEligibility(localDay),
      ),
    )
    .orderBy(
      sql`COALESCE(${memoryStates.dueOn}, ${localDay}::date) ASC`,
      sql`(${memoryStates.questionId} IS NULL) DESC`,
      sql`CASE
        WHEN ${memoryStates.dueOn} = ${localDay}::date
         AND ${latestEffectiveGrade} = 'again'
        THEN 1 ELSE 0
      END ASC`,
      sql`CASE
        WHEN ${memoryStates.dueOn} = ${localDay}::date
         AND ${latestEffectiveGrade} = 'again'
        THEN ${memoryStates.updatedAt}
        ELSE NULL
      END ASC NULLS FIRST`,
      questions.creationOrder,
      questions.id,
    );
}

async function reviewStatus(userId: string, now: Date) {
  const day = await getLearnerReviewDay(userId, now);
  const [queue, pending, future] = await Promise.all([
    queueRows(userId, day.localDay),
    getV2Client().pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM waxon_v2.answer_submissions
        WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    ),
    getV2Client().pool.query<{ next_scheduled_on: string | null }>(
      `SELECT min(ms.due_on)::text AS next_scheduled_on
         FROM waxon_v2.questions q
         JOIN waxon_v2.memory_states ms
           ON ms.user_id = q.user_id AND ms.question_id = q.id
        WHERE q.user_id = $1
          AND q.lifecycle::text = 'active'
          AND ms.due_on > $2::date`,
      [userId, day.localDay],
    ),
  ]);
  return {
    day,
    queue,
    waitingOnEvaluation: Number(pending.rows[0]?.count ?? 0) > 0,
    nextScheduledOn: future.rows[0]?.next_scheduled_on ?? null,
  };
}

export async function getLiveReviewQueue(
  userId: string,
  dependencies: Pick<ReviewDependencies, "now"> = defaultReviewDependencies,
): Promise<V2ReviewQueueResponse> {
  const [status, recentAnswers] = await Promise.all([
    reviewStatus(userId, dependencies.now()),
    recentReviewAnswers(userId),
  ]);
  const first = status.queue[0];
  return {
    question: first
      ? {
          questionId: first.questionId,
          prompt: first.prompt,
          total: status.queue.length,
          scheduledFor: first.scheduledFor,
        }
      : null,
    recentAnswers,
    waitingOnEvaluation: status.waitingOnEvaluation,
    timezone: status.day.timezone,
    localDay: status.day.localDay,
    summary: {
      queueRemaining: status.queue.length,
      nextScheduledOn: status.nextScheduledOn,
    },
  };
}

export async function flagCurrentReviewQuestion(input: {
  userId: string;
  questionId: string;
  reasons?: unknown;
  detail?: unknown;
}, dependencies: Pick<ReviewDependencies, "now"> = defaultReviewDependencies): Promise<{
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
    const reviewDay = await learnerReviewDayInTransaction(
      tx,
      input.userId,
      now,
    );
    const current = (await queueRows(input.userId, reviewDay.localDay, tx))[0];
    if (!current || current.questionId !== questionId) {
      throw new Error("This Question is no longer the current Review Question.");
    }

    await tx
      .update(questions)
      .set({
        lifecycle: "flagged",
        updatedAt: now,
      })
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

async function recentReviewAnswers(userId: string) {
  const result = await getV2Client().pool.query<{
    submission_id: string;
    answer: string;
    submitted_at: Date;
    prompt: string;
    evaluation_id: string;
    evaluation_status: "pending" | "complete" | "failed" | "superseded";
    proposed_grade: V2Grade | null;
    effective_grade: V2Grade | null;
    due_on: string | null;
    feedback: string | null;
    expected_answer: string | null;
    covered_points: unknown;
    missing_points: unknown;
    demonstrated_gap: string | null;
    confidence: number | null;
  }>(
    `SELECT submission.id AS submission_id,
            submission.answer,
            submission.submitted_at,
            question.prompt,
            evaluation.id AS evaluation_id,
            evaluation.status::text AS evaluation_status,
            evaluation.proposed_grade::text AS proposed_grade,
            effective.value::text AS effective_grade,
            memory.due_on::text,
            evaluation.feedback,
            evaluation.expected_answer,
            evaluation.covered_points,
            evaluation.missing_points,
            evaluation.demonstrated_gap,
            evaluation.confidence
       FROM waxon_v2.answer_submissions submission
       JOIN waxon_v2.questions question
         ON question.user_id = submission.user_id
        AND question.id = submission.question_id
       JOIN LATERAL (
         SELECT candidate.*
           FROM waxon_v2.evaluations candidate
          WHERE candidate.user_id = submission.user_id
            AND candidate.submission_id = submission.id
          ORDER BY candidate.created_at DESC, candidate.id DESC
          LIMIT 1
       ) evaluation ON true
       LEFT JOIN LATERAL (
         SELECT event.grade AS value
           FROM waxon_v2.grade_events event
          WHERE event.user_id = submission.user_id
            AND event.submission_id = submission.id
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
       ) effective ON true
       LEFT JOIN waxon_v2.memory_states memory
         ON memory.user_id = submission.user_id
        AND memory.question_id = submission.question_id
      WHERE submission.user_id = $1
      ORDER BY submission.submitted_at DESC, submission.id DESC
      LIMIT 20`,
    [userId],
  );
  return result.rows.map((row) => ({
      prompt: row.prompt,
      answer: row.answer,
      submittedAt: row.submitted_at.toISOString(),
      evaluation: evaluationView({
        submissionId: row.submission_id,
        evaluationId: row.evaluation_id,
        evaluationStatus: row.evaluation_status,
        proposedGrade: row.proposed_grade,
        effectiveGrade: row.effective_grade,
        dueOn: row.due_on,
        feedback: row.feedback,
        expectedAnswer: row.expected_answer,
        coveredPoints: Array.isArray(row.covered_points)
          ? row.covered_points.filter(
              (point): point is string => typeof point === "string",
            )
          : [],
        missingPoints: Array.isArray(row.missing_points)
          ? row.missing_points.filter(
              (point): point is string => typeof point === "string",
            )
          : [],
        demonstratedGap: row.demonstrated_gap,
        confidence: row.confidence,
      }),
    }));
}

export async function getLiveReviewSummary(
  userId: string,
  now = defaultReviewDependencies.now(),
): Promise<V2ReviewSummary> {
  const status = await reviewStatus(userId, now);
  return {
    queueRemaining: status.queue.length,
    nextScheduledOn: status.nextScheduledOn,
  };
}

function reviewAnswerRequestHash(
  questionId: string,
  answer: string,
): string {
  return checksum(JSON.stringify({ questionId, answer }));
}

export async function submitLiveReviewAnswer(
  input: {
    userId: string;
    questionId: string;
    answer: string;
    idempotencyKey: string;
  },
  dependencies: ReviewDependencies = defaultReviewDependencies,
): Promise<V2Evaluation> {
  const now = dependencies.now();
  const answer = input.answer.trim();
  const key = input.idempotencyKey.trim().slice(0, 200);
  if (!answer || !key) {
    throw new Error("A free-text answer and idempotency key are required.");
  }
  const requestHash = reviewAnswerRequestHash(input.questionId, answer);
  const submissionId = await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))`,
    );
    const reviewDay = await learnerReviewDayInTransaction(
      tx,
      input.userId,
      now,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-answer:${input.userId}:${input.questionId}`}))`,
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
          eq(mutationReceipts.scope, "review-answer"),
          eq(mutationReceipts.key, key),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new Error(
          "This idempotency key was already used for a different answer.",
        );
      }
      const prior = receipt.response as { submissionId?: unknown };
      if (typeof prior.submissionId !== "string") {
        throw new Error("The saved answer receipt is invalid.");
      }
      return prior.submissionId;
    }

    const [question] = await tx
      .select({
        questionId: questions.id,
        prompt: questions.prompt,
      })
      .from(questions)
      .leftJoin(
        memoryStates,
        and(
          eq(memoryStates.userId, questions.userId),
          eq(memoryStates.questionId, questions.id),
        ),
      )
      .where(
        and(
          eq(questions.userId, input.userId),
          eq(questions.id, input.questionId),
          activeQuestionEligibility(reviewDay.localDay),
        ),
      )
      .limit(1);
    if (!question) {
      throw new Error("This Question is no longer available in Review.");
    }

    const [submission] = await tx
      .insert(answerSubmissions)
      .values({
        userId: input.userId,
        questionId: question.questionId,
        answer,
        submittedAt: now,
      })
      .returning({ id: answerSubmissions.id });
    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        userId: input.userId,
        questionId: question.questionId,
        submissionId: submission.id,
        evaluator: "model",
      })
      .returning({ id: evaluations.id });
    const browserAcceptanceEvaluationAuthorized =
      authorizeBrowserAcceptanceEvaluation({
        learnerId: input.userId,
        prompt: question.prompt,
      });
    await tx.insert(jobs).values({
      userId: input.userId,
      type: "evaluate_submission",
      idempotencyKey: submission.id,
      priority: 0,
      payload: {
        submissionId: submission.id,
        evaluationId: evaluation.id,
        ...(browserAcceptanceEvaluationAuthorized
          ? { browserAcceptanceEvaluationAuthorized: true }
          : {}),
      },
    });
    await tx.insert(mutationReceipts).values({
      userId: input.userId,
      scope: "review-answer",
      key,
      requestHash,
      response: { submissionId: submission.id },
    });
    return submission.id;
  });
  return getLiveEvaluation(input.userId, submissionId);
}

export async function getLiveEvaluation(
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
  if (!row) throw new Error("Evaluation not found.");
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
  const [schedule] = await db
    .select({ dueOn: memoryStates.dueOn })
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
  return evaluationView({
    submissionId,
    evaluationId: row.id,
    evaluationStatus: row.status,
    proposedGrade: row.proposedGrade,
    effectiveGrade: effectiveGrade?.value ?? null,
    dueOn: schedule?.dueOn ?? null,
    feedback: row.feedback,
    expectedAnswer: row.expectedAnswer,
    coveredPoints: row.coveredPoints,
    missingPoints: row.missingPoints,
    demonstratedGap: row.demonstratedGap,
    confidence: row.confidence,
  });
}

async function rebuildMemoryFromGradeHistory(
  tx: V2Tx,
  input: {
    userId: string;
    questionId: string;
    effectiveTimezone: string;
    currentLocalDay: string;
  },
  gradedAt: Date,
  eventOrderAt: Date,
): Promise<void> {
  const submissions = await tx
    .select({
      id: answerSubmissions.id,
      submittedAt: answerSubmissions.submittedAt,
    })
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.questionId, input.questionId),
        eq(answerSubmissions.status, "graded"),
      ),
    )
    .orderBy(
      asc(answerSubmissions.submittedAt),
      asc(answerSubmissions.createdAt),
      asc(answerSubmissions.id),
    );
  const events = await tx
    .select({
      submissionId: gradeEvents.submissionId,
      grade: gradeEvents.value,
    })
    .from(gradeEvents)
    .innerJoin(
      answerSubmissions,
      and(
        eq(answerSubmissions.userId, gradeEvents.userId),
        eq(answerSubmissions.id, gradeEvents.submissionId),
      ),
    )
    .where(
      and(
        eq(gradeEvents.userId, input.userId),
        eq(answerSubmissions.questionId, input.questionId),
      ),
    )
    .orderBy(
      asc(gradeEvents.createdAt),
      asc(gradeEvents.id),
    );
  const latestGrades = new Map<string, V2Grade>();
  for (const event of events) {
    latestGrades.set(event.submissionId, event.grade);
  }

  let rebuilt: StoredMemoryState | null = null;
  let latestGrade: V2Grade | null = null;
  for (const submission of submissions) {
    const grade = latestGrades.get(submission.id);
    if (!grade) continue;
    latestGrade = grade;
    const calculated = applyFsrsGrade({
      memory: rebuilt,
      grade,
      now: submission.submittedAt,
    });
    rebuilt =
      grade === "again"
        ? {
            ...calculated,
            dueAt: submission.submittedAt,
            scheduledDays: 0,
          }
        : calculated;
  }

  if (!rebuilt || !latestGrade) {
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
  let stored =
    latestGrade === "again"
      ? { ...rebuilt, dueAt: gradedAt, scheduledDays: 0 }
      : rebuilt;
  let dueOn =
    latestGrade === "again"
      ? input.currentLocalDay
      : dateInTimezone(stored.dueAt, input.effectiveTimezone);
  if (latestGrade !== "again" && dueOn <= input.currentLocalDay) {
    const intervalDays = Math.max(1, stored.scheduledDays);
    const shifted = await tx.execute<{
      due_at: Date | string;
      due_on: string;
    }>(sql`
      SELECT
        (
          (${input.currentLocalDay}::date + ${intervalDays}::integer)::timestamp
          AT TIME ZONE ${input.effectiveTimezone}
        ) AS due_at,
        (${input.currentLocalDay}::date + ${intervalDays}::integer)::text AS due_on
    `);
    const future = shifted.rows[0];
    if (!future) {
      throw new Error("Could not schedule the next Local Day.");
    }
    const futureDueAt =
      future.due_at instanceof Date
        ? future.due_at
        : new Date(future.due_at);
    if (!Number.isFinite(futureDueAt.getTime())) {
      throw new Error("Could not schedule the next Local Day.");
    }
    stored = {
      ...stored,
      dueAt: futureDueAt,
    };
    dueOn = future.due_on;
  }

  await tx
    .insert(memoryStates)
    .values({
      userId: input.userId,
      questionId: input.questionId,
      dueAt: stored.dueAt,
      dueOn,
      lastReviewAt: stored.lastReviewAt,
      stability: stored.stability,
      difficulty: stored.difficulty,
      elapsedDays: stored.elapsedDays,
      scheduledDays: stored.scheduledDays,
      reps: stored.reps,
      lapses: stored.lapses,
      state: stored.state,
      learningSteps: stored.learningSteps,
      schedulerVersion: SCHEDULER_VERSION,
      updatedAt: eventOrderAt,
    })
    .onConflictDoUpdate({
      target: [memoryStates.userId, memoryStates.questionId],
      set: {
        dueAt: stored.dueAt,
        dueOn,
        lastReviewAt: stored.lastReviewAt,
        stability: stored.stability,
        difficulty: stored.difficulty,
        elapsedDays: stored.elapsedDays,
        scheduledDays: stored.scheduledDays,
        reps: stored.reps,
        lapses: stored.lapses,
        state: stored.state,
        learningSteps: stored.learningSteps,
        schedulerVersion: SCHEDULER_VERSION,
        updatedAt: eventOrderAt,
      },
    });
}

async function applyGradeInTransaction(
  tx: V2Tx,
  input: {
    userId: string;
    submissionId: string;
    grade: V2Grade;
    origin: "model" | "self" | "correction";
    evaluationId?: string | null;
    effectiveTimezone: string;
    currentLocalDay: string;
  },
  eventAt: Date,
): Promise<void> {
  const [submission] = await tx
    .select({
      id: answerSubmissions.id,
      questionId: answerSubmissions.questionId,
    })
    .from(answerSubmissions)
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, input.submissionId),
      ),
    )
    .limit(1);
  if (!submission) throw new Error("Submission not found.");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))`,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`review-grade:${input.userId}`}))`,
  );
  const [latestEvent] = await tx
    .select({ createdAt: gradeEvents.createdAt })
    .from(gradeEvents)
    .where(eq(gradeEvents.userId, input.userId))
    .orderBy(desc(gradeEvents.createdAt), desc(gradeEvents.id))
    .limit(1);
  const createdAt =
    latestEvent && latestEvent.createdAt >= eventAt
      ? new Date(latestEvent.createdAt.getTime() + 1)
      : eventAt;
  await tx.insert(gradeEvents).values({
    userId: input.userId,
    questionId: submission.questionId,
    submissionId: input.submissionId,
    value: input.grade,
    origin: input.origin,
    evaluationId: input.evaluationId ?? null,
    createdAt,
  });
  await tx
    .update(answerSubmissions)
    .set({ status: "graded" })
    .where(
      and(
        eq(answerSubmissions.userId, input.userId),
        eq(answerSubmissions.id, submission.id),
      ),
    );
  await rebuildMemoryFromGradeHistory(
    tx,
    {
      userId: input.userId,
      questionId: submission.questionId,
      effectiveTimezone: input.effectiveTimezone,
      currentLocalDay: input.currentLocalDay,
    },
    eventAt,
    createdAt,
  );
}

function demonstratedGapFor(input: {
  demonstratedGap: string | null;
  missingPoints: string[];
}): string {
  const statedGap = input.demonstratedGap?.trim();
  if (input.missingPoints.length === 0) {
    return "No gap was demonstrated by this successful recall.";
  }
  if (statedGap) return statedGap;
  return `The Learner Answer did not demonstrate: ${input.missingPoints.join("; ")}.`;
}

export async function runLiveEvaluationJob(
  jobId: string,
  dependencies: ReviewDependencies = defaultReviewDependencies,
): Promise<void> {
  const db = getV2Db();
  const now = dependencies.now();
  const job = await claimV2Job(jobId, "evaluate_submission", now);
  if (!job) return;
  const submissionId =
    typeof job.payload.submissionId === "string" ? job.payload.submissionId : "";
  const evaluationId =
    typeof job.payload.evaluationId === "string" ? job.payload.evaluationId : "";
  const [row] = await db
    .select({
      submissionStatus: answerSubmissions.status,
      answer: answerSubmissions.answer,
      submittedAt: answerSubmissions.submittedAt,
      prompt: questions.prompt,
      referenceAnswer: questions.referenceAnswer,
    })
    .from(answerSubmissions)
    .innerJoin(
      questions,
      and(
        eq(questions.userId, answerSubmissions.userId),
        eq(questions.id, answerSubmissions.questionId),
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
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(jobs.id, jobId));
    return;
  }
  try {
    const result = reconcileRecallEvaluation({
      prompt: row.prompt,
      result: await dependencies.evaluateAnswer({
        userId: job.userId,
        prompt: row.prompt,
        referenceAnswer: row.referenceAnswer,
        answer: row.answer,
        browserAcceptanceEvaluationAuthorized:
          job.payload.browserAcceptanceEvaluationAuthorized === true,
      }),
    });
    if (result.confidence < 0.55) {
      await db
        .update(evaluations)
        .set({
          status: "failed",
          feedback: "The evaluator was uncertain. Please self-grade.",
          expectedAnswer: row.referenceAnswer,
          demonstratedGap:
            result.demonstratedGap?.trim() ||
            "The evaluator could not determine a Demonstrated Gap.",
          confidence: result.confidence,
          error: "Low confidence",
          completedAt: now,
        })
        .where(eq(evaluations.id, evaluationId));
    } else {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${job.userId}`}))`,
        );
        const reviewDay = await learnerReviewDayInTransaction(
          tx,
          job.userId,
          now,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`review-grade:${job.userId}:${submissionId}`}))`,
        );
        const [submission] = await tx
          .select({ status: answerSubmissions.status })
          .from(answerSubmissions)
          .where(
            and(
              eq(answerSubmissions.userId, job.userId),
              eq(answerSubmissions.id, submissionId),
            ),
          )
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
            expectedAnswer: row.referenceAnswer,
            coveredPoints: result.coveredPoints,
            missingPoints: result.missingPoints,
            demonstratedGap: demonstratedGapFor(result),
            confidence: result.confidence,
            completedAt: now,
          })
          .where(eq(evaluations.id, evaluationId));
        await applyGradeInTransaction(
          tx,
          {
            userId: job.userId,
            submissionId,
            grade: result.grade,
            origin: "model",
            evaluationId,
            effectiveTimezone: reviewDay.effectiveTimezone,
            currentLocalDay: reviewDay.localDay,
          },
          now,
        );
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
    const exhausted = job.attempts >= 3;
    await db
      .update(jobs)
      .set({
        status: exhausted ? "failed" : "pending",
        runAfter: new Date(now.getTime() + job.attempts * 30_000),
        lockedUntil: null,
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: now,
      })
      .where(and(eq(jobs.userId, job.userId), eq(jobs.id, job.id)));
    if (exhausted) {
      await db
        .update(evaluations)
        .set({
          status: "failed",
          feedback: "Evaluation failed. Please self-grade.",
          expectedAnswer: row.referenceAnswer,
          demonstratedGap:
            "The evaluator could not determine a Demonstrated Gap.",
          error:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Unknown error",
          completedAt: now,
        })
        .where(
          and(
            eq(evaluations.userId, job.userId),
            eq(evaluations.id, evaluationId),
          ),
        );
    }
    throw error;
  }
}

export async function runLiveEvaluationForSubmission(
  userId: string,
  submissionId: string,
  dependencies: ReviewDependencies = defaultReviewDependencies,
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
  await runLiveEvaluationJob(job.id, dependencies);
  return getLiveEvaluation(userId, submissionId);
}

export async function applyLiveLearnerGrade(
  input: { userId: string; submissionId: string; grade: V2Grade },
  dependencies: Pick<ReviewDependencies, "now"> = defaultReviewDependencies,
): Promise<V2Evaluation> {
  const db = getV2Db();
  const now = dependencies.now();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))`,
    );
    const reviewDay = await learnerReviewDayInTransaction(
      tx,
      input.userId,
      now,
    );
    const [submission] = await tx
      .select({ status: answerSubmissions.status })
      .from(answerSubmissions)
      .where(
        and(
          eq(answerSubmissions.userId, input.userId),
          eq(answerSubmissions.id, input.submissionId),
        ),
      )
      .limit(1);
    if (!submission) throw new Error("Submission not found.");
    const [latestEvaluation] = await tx
      .select({ id: evaluations.id, status: evaluations.status })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.userId, input.userId),
          eq(evaluations.submissionId, input.submissionId),
        ),
      )
      .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
      .limit(1);
    if (!latestEvaluation) {
      throw new Error("Evaluation not found.");
    }
    if (submission.status === "pending" && latestEvaluation.status !== "failed") {
      throw new Error("Self-grading is available only after evaluation fails.");
    }
    if (submission.status !== "pending" && submission.status !== "graded") {
      throw new Error("This Learner Answer cannot be graded.");
    }
    await applyGradeInTransaction(
      tx,
      {
        ...input,
        origin: submission.status === "pending" ? "self" : "correction",
        evaluationId: latestEvaluation.id,
        effectiveTimezone: reviewDay.effectiveTimezone,
        currentLocalDay: reviewDay.localDay,
      },
      now,
    );
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
  });
  return getLiveEvaluation(input.userId, input.submissionId);
}
