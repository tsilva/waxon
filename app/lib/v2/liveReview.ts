import { createHash, randomUUID } from "node:crypto";
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
} from "./settings.ts";
import { normalizeReviewFlagInput } from "./reviewFlag.ts";
import { relatedTags } from "./semanticTags.ts";
import {
  composeRecallFeedback,
  deriveAnswerGrades,
  evaluateRecallWithRetries,
  isRetryableEvaluationError,
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
  const [settings] = await tx
    .select({ timezone: learnerSettings.timezone })
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);
  const effectiveTimezone = settings?.timezone ?? "UTC";
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
  const automatedFeedback = automatedRecallResult
    ? composeRecallFeedback({
        recallResult: automatedRecallResult,
        scoringIssues,
      })
    : input.feedback;
  const feedback = wasCorrected && recallResult
    ? `Evaluation changed to ${recallResult[0].toUpperCase()}${recallResult.slice(1)}. Original feedback: ${automatedFeedback ?? "Unavailable"}`
    : automatedFeedback;
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

// The count covers every eligible Question; the window only bounds transferred content.
async function reviewStatus(userId: string, now: Date, selection: {
  questionId?: string | null; afterQuestionId?: string | null;
} = {}, includeQuestions = true) {
  const result = await getV2Client().pool.query<{
    timezone: string | null; local_day: string; total: string;
    waiting: boolean; next_scheduled_on: string | null; library_empty: boolean;
    candidates: Array<{ questionId: string; prompt: string; scheduledFor: string | null }>;
  }>(
    `WITH day AS (
       SELECT settings.timezone,
              ($2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date AS local_day
         FROM waxon_v2.users learner
         LEFT JOIN waxon_v2.learner_settings settings ON settings.user_id = learner.id
        WHERE learner.id = $1
     ), eligible AS MATERIALIZED (
       SELECT q.id, q.prompt, q.creation_order, q.added_through_mcp,
              ms.question_id AS memory_id, ms.due_on, ms.updated_at
         FROM waxon_v2.questions q CROSS JOIN day
         LEFT JOIN waxon_v2.memory_states ms ON ms.user_id = q.user_id AND ms.question_id = q.id
        WHERE q.user_id = $1 AND q.lifecycle = 'active'
          AND (ms.question_id IS NULL OR ms.due_on <= day.local_day)
          AND NOT EXISTS (SELECT 1 FROM waxon_v2.answer_submissions pending
                           WHERE pending.user_id = $1 AND pending.question_id = q.id AND pending.status = 'pending')
     ), latest AS (
       SELECT DISTINCT ON (submission.question_id) submission.question_id, event.grade
         FROM waxon_v2.answer_submissions submission
         JOIN waxon_v2.grade_events event ON event.user_id = submission.user_id AND event.submission_id = submission.id
        WHERE submission.user_id = $1 AND $5::boolean
        ORDER BY submission.question_id, submission.submitted_at DESC, submission.created_at DESC,
                 submission.id DESC, event.created_at DESC, event.id DESC
     ), prioritized AS (
       SELECT eligible.*, latest.grade,
              (added_through_mcp AND NOT EXISTS (
                 SELECT 1 FROM waxon_v2.answer_submissions submission
                  WHERE submission.user_id = $1 AND submission.question_id = eligible.id
              )) AS unanswered_mcp
         FROM eligible LEFT JOIN latest ON latest.question_id = eligible.id WHERE $5::boolean
     ), ordered AS MATERIALIZED (
       SELECT prioritized.*, row_number() OVER (ORDER BY
         unanswered_mcp DESC,
         CASE WHEN unanswered_mcp THEN creation_order END DESC NULLS LAST,
         COALESCE(due_on, day.local_day), (memory_id IS NULL) DESC,
         CASE WHEN due_on = day.local_day AND grade = 'again' THEN 1 ELSE 0 END,
         CASE WHEN due_on = day.local_day AND grade = 'again' THEN updated_at END ASC NULLS FIRST,
         creation_order, id) AS position
         FROM prioritized CROSS JOIN day
     ), chosen AS (
       SELECT COALESCE(
         (SELECT position % (SELECT count(*) FROM ordered) + 1 FROM ordered WHERE id::text = $4),
         (SELECT position FROM ordered WHERE id::text = $3), 1) AS position
     ), candidate_window AS (
       SELECT ordered.*, (ordered.position - chosen.position + (SELECT count(*) FROM ordered))
              % (SELECT count(*) FROM ordered) AS advance_offset
         FROM ordered CROSS JOIN chosen
     )
     SELECT day.timezone, day.local_day::text,
            (SELECT count(*)::text FROM eligible) AS total,
            EXISTS (SELECT 1 FROM waxon_v2.answer_submissions WHERE user_id = $1 AND status = 'pending') AS waiting,
            (SELECT min(ms.due_on)::text FROM waxon_v2.memory_states ms
               JOIN waxon_v2.questions q ON q.user_id = ms.user_id AND q.id = ms.question_id
              WHERE q.user_id = $1 AND q.lifecycle = 'active' AND ms.due_on > day.local_day) AS next_scheduled_on,
            NOT EXISTS (SELECT 1 FROM waxon_v2.questions WHERE user_id = $1) AS library_empty,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('questionId', id, 'prompt', prompt,
                         'scheduledFor', due_on::text) ORDER BY advance_offset) FROM candidate_window WHERE advance_offset < 9), '[]'::jsonb) AS candidates
       FROM day`,
    [userId, now, selection.questionId?.trim() || null, selection.afterQuestionId?.trim() || null, includeQuestions],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Could not load learner Review state.");
  return row;
}

export async function getLiveReviewQueue(
  userId: string,
  dependencies: Pick<ReviewDependencies, "now"> = defaultReviewDependencies,
  selection: { questionId?: string | null; afterQuestionId?: string | null } = {},
): Promise<V2ReviewQueueResponse> {
  const [status, recentAnswers] = await Promise.all([
    reviewStatus(userId, dependencies.now(), selection), recentReviewAnswers(userId),
  ]);
  const tags = await relatedTags({ learnerId: userId,
    questionIds: status.candidates.map((question) => question.questionId), limit: 3 });
  const candidates = status.candidates.map((question) => ({ ...question,
    total: Number(status.total), relatedTags: tags.get(question.questionId) ?? [] }));
  return {
    question: candidates[0] ?? null, upcomingQuestions: candidates.slice(1), recentAnswers,
    isLibraryEmpty: status.library_empty, waitingOnEvaluation: status.waiting,
    timezone: status.timezone, localDay: status.local_day,
    summary: { queueRemaining: Number(status.total), nextScheduledOn: status.next_scheduled_on },
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
    const [available] = await tx.select({ questionId: questions.id }).from(questions)
      .leftJoin(memoryStates, and(eq(memoryStates.userId, questions.userId), eq(memoryStates.questionId, questions.id)))
      .where(and(eq(questions.userId, input.userId), eq(questions.id, questionId), activeQuestionEligibility(reviewDay.localDay)))
      .limit(1);
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

async function recentReviewAnswers(userId: string, submissionIds: string[] | null = null) {
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
      WHERE submission.user_id = $1 AND ($2::uuid[] IS NULL OR submission.id = ANY($2::uuid[]))
      ORDER BY submission.submitted_at DESC, submission.id DESC
      LIMIT 20`,
    [userId, submissionIds],
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
        confidence: row.confidence,
      }),
    }));
}

export async function getLiveReviewSummary(
  userId: string,
  now = defaultReviewDependencies.now(),
): Promise<V2ReviewSummary> {
  const result = await getV2Client().pool.query<{ queue_remaining: number; next_scheduled_on: string | null }>(
    `WITH day AS (
       SELECT ($2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date AS local_day
         FROM waxon_v2.users learner LEFT JOIN waxon_v2.learner_settings settings ON settings.user_id = learner.id
        WHERE learner.id = $1
     )
     SELECT count(*) FILTER (WHERE (ms.question_id IS NULL OR ms.due_on <= day.local_day)
              AND NOT EXISTS (SELECT 1 FROM waxon_v2.answer_submissions pending
                WHERE pending.user_id = $1 AND pending.question_id = q.id AND pending.status = 'pending'))::integer AS queue_remaining,
            (min(ms.due_on) FILTER (WHERE ms.due_on > day.local_day))::text AS next_scheduled_on
       FROM waxon_v2.questions q CROSS JOIN day
       LEFT JOIN waxon_v2.memory_states ms ON ms.user_id = q.user_id AND ms.question_id = q.id
      WHERE q.user_id = $1 AND q.lifecycle = 'active'`, [userId, now]);
  return { queueRemaining: result.rows[0].queue_remaining, nextScheduledOn: result.rows[0].next_scheduled_on };

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
  const saved = await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`WITH queue_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))
      ) SELECT pg_advisory_xact_lock(hashtext(${`review-answer:${input.userId}:${input.questionId}`})) FROM queue_lock`,
    );
    const reviewDay = await learnerReviewDayInTransaction(
      tx,
      input.userId,
      now,
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

    const submissionId = randomUUID();
    const evaluationId = randomUUID();
    const browserAcceptanceEvaluationAuthorized = authorizeBrowserAcceptanceEvaluation({
      learnerId: input.userId, prompt: question.prompt,
    });
    const payload = JSON.stringify({ submissionId, evaluationId,
      ...(browserAcceptanceEvaluationAuthorized ? { browserAcceptanceEvaluationAuthorized: true } : {}) });
    // Evidence, evaluator, durable job, and retry receipt commit together in one trip.
    await tx.execute(sql`WITH submission AS (
      INSERT INTO waxon_v2.answer_submissions (id, user_id, question_id, answer, submitted_at)
      VALUES (${submissionId}::uuid, ${input.userId}, ${question.questionId}::uuid, ${answer}, ${now.toISOString()}::timestamptz)
      RETURNING id, user_id, question_id
    ), evaluation AS (
      INSERT INTO waxon_v2.evaluations (id, user_id, question_id, submission_id, evaluator)
      SELECT ${evaluationId}::uuid, user_id, question_id, id, 'model' FROM submission
      RETURNING id
    ), job AS (
      INSERT INTO waxon_v2.jobs (user_id, type, idempotency_key, priority, payload)
      SELECT ${input.userId}, 'evaluate_submission', ${submissionId}, 0, ${payload}::jsonb FROM evaluation
      RETURNING id
    )
    INSERT INTO waxon_v2.mutation_receipts (user_id, scope, key, request_hash, response)
    SELECT ${input.userId}, 'review-answer', ${key}, ${requestHash},
           ${JSON.stringify({ submissionId })}::jsonb FROM job`);
    return evaluationView({ submissionId, evaluationId, evaluationStatus: "pending",
      proposedGrade: null, proposedRecallResult: null, correctedRecallResult: null,
      effectiveGrade: null, dueOn: null, feedback: null, expectedAnswer: null,
      coveredPoints: [], missingPoints: [], scoringIssues: [], confidence: null });
  });
  return typeof saved === "string" ? getLiveEvaluation(input.userId, saved) : saved;
}


export async function getLiveEvaluations(userId: string, submissionIds: string[]): Promise<V2Evaluation[]> {
  if (submissionIds.length === 0 || submissionIds.length > 20) throw new Error("Request 1–20 evaluations.");
  if (submissionIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))) {
    throw new Error("Invalid submission ID.");
  }
  const turns = await recentReviewAnswers(userId, submissionIds);
  return turns.map((turn) => turn.evaluation);
}

export async function getLiveEvaluation(userId: string, submissionId: string): Promise<V2Evaluation> {
  const [evaluation] = await getLiveEvaluations(userId, [submissionId]);
  if (!evaluation) throw new Error("Evaluation not found.");
  return evaluation;
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
    throw new Error("Graded Learner Answer has no evaluation result evidence.");
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
      evaluate: (signal) =>
        dependencies.evaluateAnswer({
          userId: job.userId,
          prompt: row.prompt,
          referenceAnswer: row.referenceAnswer,
          answer: row.answer,
          signal,
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
    const exhausted = job.attempts >= 3 || !isRetryableEvaluationError(error);
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
      throw new Error("Only a completed evaluation can be corrected.");
    }
    // Queue lock serializes corrections; advance equal timestamps so the latest
    // correction never depends on randomly ordered UUIDs.
    await tx.execute(sql`INSERT INTO waxon_v2.recall_result_corrections
      (user_id, question_id, submission_id, recall_result, created_at)
      SELECT ${input.userId}, ${submission.questionId}::uuid, ${input.submissionId}::uuid,
             ${input.recallResult}::waxon_v2.recall_result,
             GREATEST(${now.toISOString()}::timestamptz,
               COALESCE(max(created_at) + interval '1 millisecond', ${now.toISOString()}::timestamptz))
        FROM waxon_v2.recall_result_corrections
       WHERE user_id = ${input.userId} AND submission_id = ${input.submissionId}::uuid`);
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
