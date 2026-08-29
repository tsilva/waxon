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
  recallResultCorrections,
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
import {
  deriveAnswerGrades,
  evaluateRecallWithRetries,
  legacyGradeToRecallResult,
  type RecallEvaluationResult,
} from "./recallEvaluation.ts";
import type {
  V2Evaluation,
  V2Grade,
  V2QuestionFlag,
  V2RecallResult,
  V2ReviewQueueResponse,
  V2ReviewSummary,
} from "./types.ts";

type ReviewDependencies = {
  now(): Date;
  evaluateAnswer(
    input: Parameters<typeof evaluateRecall>[0],
  ): Promise<RecallEvaluationResult>;
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
  proposedRecallResult: V2RecallResult | null;
  correctedRecallResult: V2RecallResult | null;
  effectiveGrade: V2Grade | null;
  dueOn: string | null;
  feedback: string | null;
  expectedAnswer: string | null;
  coveredPoints: string[];
  missingPoints: string[];
  scoringIssues: string[];
  clarifications: string[];
  confidence: number | null;
}): V2Evaluation {
  const legacyGrade = input.proposedGrade ?? input.effectiveGrade;
  const automatedRecallResult =
    input.proposedRecallResult ??
    (legacyGrade ? legacyGradeToRecallResult(legacyGrade) : null);
  const recallResult = input.correctedRecallResult ?? automatedRecallResult;
  const scoringIssues =
    input.scoringIssues.length > 0 ? input.scoringIssues : input.missingPoints;
  const wasCorrected = Boolean(
    input.correctedRecallResult &&
      input.correctedRecallResult !== automatedRecallResult,
  );
  const feedback = wasCorrected && recallResult
    ? `Recall Result corrected to ${recallResult[0].toUpperCase()}${recallResult.slice(1)}. The original automated feedback was: ${input.feedback ?? "Unavailable"}`
    : input.feedback;
  return {
    submissionId: input.submissionId,
    evaluationId: input.evaluationId,
    status:
      input.evaluationStatus === "complete" || recallResult
        ? "complete"
        : input.evaluationStatus === "failed"
          ? "failed"
          : "pending",
    recallResult,
    nextDueOn: recallResult ? input.dueOn : null,
    feedback,
    expectedAnswer: input.expectedAnswer,
    coveredPoints: input.coveredPoints,
    scoringIssues,
    clarifications: input.clarifications,
    confidence: input.confidence,
    canRetryEvaluation: input.evaluationStatus === "failed" && !recallResult,
    canCorrectRecallResult: Boolean(recallResult),
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
  selection: {
    questionId?: string | null;
    afterQuestionId?: string | null;
  } = {},
): Promise<V2ReviewQueueResponse> {
  const [status, recentAnswers] = await Promise.all([
    reviewStatus(userId, dependencies.now()),
    recentReviewAnswers(userId),
  ]);
  const requestedQuestionId = selection.questionId?.trim();
  const afterQuestionId = selection.afterQuestionId?.trim();
  const requested = requestedQuestionId
    ? status.queue.find((question) => question.questionId === requestedQuestionId)
    : undefined;
  const afterIndex = afterQuestionId
    ? status.queue.findIndex((question) => question.questionId === afterQuestionId)
    : -1;
  const selected =
    afterIndex >= 0
      ? status.queue[(afterIndex + 1) % status.queue.length]
      : requested ?? status.queue[0];
  return {
    question: selected
      ? {
          questionId: selected.questionId,
          prompt: selected.prompt,
          total: status.queue.length,
          scheduledFor: selected.scheduledFor,
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
    const available = (await queueRows(input.userId, reviewDay.localDay, tx))
      .some((question) => question.questionId === questionId);
    if (!available) {
      throw new Error("This Question is no longer available in Review.");
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
    proposed_recall_result: V2RecallResult | null;
    corrected_recall_result: V2RecallResult | null;
    effective_grade: V2Grade | null;
    due_on: string | null;
    feedback: string | null;
    expected_answer: string | null;
    covered_points: unknown;
    missing_points: unknown;
    scoring_issues: unknown;
    clarifications: unknown;
    confidence: number | null;
  }>(
    `SELECT submission.id AS submission_id,
            submission.answer,
            submission.submitted_at,
            question.prompt,
            evaluation.id AS evaluation_id,
            evaluation.status::text AS evaluation_status,
            evaluation.proposed_grade::text AS proposed_grade,
            evaluation.proposed_recall_result::text AS proposed_recall_result,
            correction.value::text AS corrected_recall_result,
            effective.value::text AS effective_grade,
            memory.due_on::text,
            evaluation.feedback,
            evaluation.expected_answer,
            evaluation.covered_points,
            evaluation.missing_points,
            evaluation.scoring_issues,
            evaluation.clarifications,
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
         SELECT event.recall_result AS value
           FROM waxon_v2.recall_result_corrections event
          WHERE event.user_id = submission.user_id
            AND event.submission_id = submission.id
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT 1
       ) correction ON true
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
        proposedRecallResult: row.proposed_recall_result,
        correctedRecallResult: row.corrected_recall_result,
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
        scoringIssues: Array.isArray(row.scoring_issues)
          ? row.scoring_issues.filter(
              (point): point is string => typeof point === "string",
            )
          : [],
        clarifications: Array.isArray(row.clarifications)
          ? row.clarifications.filter(
              (point): point is string => typeof point === "string",
            )
          : [],
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
    .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
    .limit(1);
  if (!row) throw new Error("Evaluation not found.");
  const [correction] = await db
    .select({ value: recallResultCorrections.value })
    .from(recallResultCorrections)
    .where(
      and(
        eq(recallResultCorrections.userId, userId),
        eq(recallResultCorrections.submissionId, submissionId),
      ),
    )
    .orderBy(
      desc(recallResultCorrections.createdAt),
      desc(recallResultCorrections.id),
    )
    .limit(1);
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
    proposedRecallResult: row.proposedRecallResult,
    correctedRecallResult: correction?.value ?? null,
    effectiveGrade: effectiveGrade?.value ?? null,
    dueOn: schedule?.dueOn ?? null,
    feedback: row.feedback,
    expectedAnswer: row.expectedAnswer,
    coveredPoints: row.coveredPoints,
    missingPoints: row.missingPoints,
    scoringIssues: row.scoringIssues,
    clarifications: row.clarifications,
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

async function rebuildDerivedGradesInTransaction(
  tx: V2Tx,
  input: {
    userId: string;
    submissionId: string;
    origin: "model" | "correction";
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
  const evidence = await tx.execute<{
    submission_id: string;
    evaluation_id: string | null;
    proposed_recall_result: V2RecallResult | null;
    corrected_recall_result: V2RecallResult | null;
    latest_grade: V2Grade | null;
  }>(sql`
    SELECT submission.id AS submission_id,
           evaluation.id AS evaluation_id,
           evaluation.proposed_recall_result::text AS proposed_recall_result,
           correction.recall_result::text AS corrected_recall_result,
           latest_grade.grade::text AS latest_grade
      FROM waxon_v2.answer_submissions submission
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.proposed_recall_result
          FROM waxon_v2.evaluations candidate
         WHERE candidate.user_id = submission.user_id
           AND candidate.submission_id = submission.id
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
      ) evaluation ON true
      LEFT JOIN LATERAL (
        SELECT event.recall_result
          FROM waxon_v2.recall_result_corrections event
         WHERE event.user_id = submission.user_id
           AND event.submission_id = submission.id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
      ) correction ON true
      LEFT JOIN LATERAL (
        SELECT event.grade
          FROM waxon_v2.grade_events event
         WHERE event.user_id = submission.user_id
           AND event.submission_id = submission.id
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT 1
      ) latest_grade ON true
     WHERE submission.user_id = ${input.userId}
       AND submission.question_id = ${submission.questionId}
       AND submission.status = 'graded'
     ORDER BY submission.submitted_at, submission.created_at, submission.id
  `);
  const effectiveResults = evidence.rows.map((row) => {
    const result = row.corrected_recall_result ?? row.proposed_recall_result;
    if (result) return result;
    if (row.latest_grade) return legacyGradeToRecallResult(row.latest_grade);
    throw new Error("Graded Learner Answer has no Recall Result evidence.");
  });
  const derivedGrades = deriveAnswerGrades(effectiveResults);
  const [latestEvent] = await tx
    .select({ createdAt: gradeEvents.createdAt })
    .from(gradeEvents)
    .where(eq(gradeEvents.userId, input.userId))
    .orderBy(desc(gradeEvents.createdAt), desc(gradeEvents.id))
    .limit(1);
  let createdAt =
    latestEvent && latestEvent.createdAt >= eventAt
      ? new Date(latestEvent.createdAt.getTime() + 1)
      : eventAt;
  for (const [index, row] of evidence.rows.entries()) {
    const grade = derivedGrades[index];
    if (!grade || row.latest_grade === grade) continue;
    await tx.insert(gradeEvents).values({
      userId: input.userId,
      questionId: submission.questionId,
      submissionId: row.submission_id,
      value: grade,
      origin: input.origin,
      evaluationId: row.evaluation_id,
      derivationVersion: "recall-result-v1",
      createdAt,
    });
    createdAt = new Date(createdAt.getTime() + 1);
  }
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
    const result = await evaluateRecallWithRetries({
      prompt: row.prompt,
      evaluate: () =>
        dependencies.evaluateAnswer({
          userId: job.userId,
          prompt: row.prompt,
          referenceAnswer: row.referenceAnswer,
          answer: row.answer,
          browserAcceptanceEvaluationAuthorized:
            job.payload.browserAcceptanceEvaluationAuthorized === true,
        }),
    });
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
            proposedRecallResult: result.recallResult,
            feedback: result.feedback,
            expectedAnswer: row.referenceAnswer,
            coveredPoints: result.coveredPoints,
            scoringIssues: result.scoringIssues,
            clarifications: result.clarifications,
            confidence: result.confidence,
            completedAt: now,
          })
          .where(eq(evaluations.id, evaluationId));
        await tx
          .update(answerSubmissions)
          .set({ status: "graded" })
          .where(
            and(
              eq(answerSubmissions.userId, job.userId),
              eq(answerSubmissions.id, submissionId),
            ),
          );
        await rebuildDerivedGradesInTransaction(
          tx,
          {
            userId: job.userId,
            submissionId,
            origin: "model",
            effectiveTimezone: reviewDay.effectiveTimezone,
            currentLocalDay: reviewDay.localDay,
          },
          now,
        );
    });
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
          feedback: "Evaluation failed. Retry evaluation to classify this answer.",
          expectedAnswer: row.referenceAnswer,
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

export async function applyLiveRecallResultCorrection(
  input: {
    userId: string;
    submissionId: string;
    recallResult: V2RecallResult;
  },
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
      .select({
        status: answerSubmissions.status,
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
    if (submission.status !== "graded") {
      throw new Error("Only a completed Recall Result can be corrected.");
    }
    await tx.insert(recallResultCorrections).values({
      userId: input.userId,
      questionId: submission.questionId,
      submissionId: input.submissionId,
      value: input.recallResult,
      createdAt: now,
    });
    await rebuildDerivedGradesInTransaction(
      tx,
      {
        userId: input.userId,
        submissionId: input.submissionId,
        origin: "correction",
        effectiveTimezone: reviewDay.effectiveTimezone,
        currentLocalDay: reviewDay.localDay,
      },
      now,
    );
  });
  return getLiveEvaluation(input.userId, input.submissionId);
}

export async function retryLiveEvaluation(
  input: { userId: string; submissionId: string },
  dependencies: Pick<ReviewDependencies, "now"> = defaultReviewDependencies,
): Promise<V2Evaluation> {
  const now = dependencies.now();
  await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-grade:${input.userId}:${input.submissionId}`}))`,
    );
    const [submission] = await tx
      .select({
        status: answerSubmissions.status,
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
    const [latestEvaluation] = await tx
      .select({ status: evaluations.status })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.userId, input.userId),
          eq(evaluations.submissionId, input.submissionId),
        ),
      )
      .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
      .limit(1);
    if (submission.status !== "pending" || latestEvaluation?.status !== "failed") {
      throw new Error("Only a failed evaluation can be retried.");
    }
    const [evaluationJob] = await tx
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, input.userId),
          eq(jobs.type, "evaluate_submission"),
          eq(jobs.idempotencyKey, input.submissionId),
        ),
      )
      .limit(1);
    if (!evaluationJob) throw new Error("Evaluation job not found.");
    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        userId: input.userId,
        questionId: submission.questionId,
        submissionId: input.submissionId,
        evaluator: "model",
        createdAt: now,
      })
      .returning({ id: evaluations.id });
    const [restartedJob] = await tx
      .update(jobs)
      .set({
        status: "pending",
        attempts: 0,
        progress: 0,
        runAfter: now,
        lockedUntil: null,
        error: null,
        payload: {
          ...evaluationJob.payload,
          submissionId: input.submissionId,
          evaluationId: evaluation.id,
        },
        updatedAt: now,
      })
      .where(eq(jobs.id, evaluationJob.id))
      .returning({ id: jobs.id });
    if (!restartedJob) throw new Error("Evaluation job could not be restarted.");
  });
  return getLiveEvaluation(input.userId, input.submissionId);
}
