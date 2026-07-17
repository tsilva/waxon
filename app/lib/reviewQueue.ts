import { after } from "next/server";
import {
  applyEvaluationToPostgres,
  countDueQuestions,
  createAnswerEvaluationRecord,
  flagQuestionForReview,
  getActiveAnswerEvaluationQuestionIds,
  getDueQuestions,
  getNextScheduledQuestionDue,
  getVisibleAnswerEvaluations,
  getQuestionSnapshotById,
  getRecentQuestionAttempts,
  resolveAnswerEvaluationRecord,
  updateAnswerEvaluationPhase,
  type DueQuestion,
} from "./postgresStore";
import { questionHasActiveConceptTag } from "./conceptTags";
import {
  evaluateAnswer,
  EVALUATION_TIMEOUT_MS,
  failedEvaluation,
  type EvaluationResult,
} from "./evaluateAnswer";
import { recordPendingLlmTrace } from "./llmTraceStore";
import { serializeReviews } from "./scheduler";
import type {
  EvaluationPhase,
  QuestionAttempt,
  ReviewActivity,
  ReviewQueueItem,
  ReviewSessionQueueResponse,
  ReviewSummary,
} from "./reviewTypes";

export const RESOLVED_JUDGING_VISIBLE_MS = 5 * 60_000;
const EVALUATION_PROCESSING_TIMEOUT_MS = EVALUATION_TIMEOUT_MS;
const ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS = 5 * 60_000;
const REVIEW_SESSION_QUEUE_LIMIT = 200;

type Submission = {
  evaluationId: string;
  traceId: string;
  questionId: string;
  question: string;
  userId: string;
  answer: string;
  expectedAnswer: string | null;
  submittedAt: number;
  previousReviews: string;
};

function toReviewQueueItem(
  item: DueQuestion,
  input: {
    now: number;
    attempts?: QuestionAttempt[];
  },
): ReviewQueueItem {
  const msUntilDue = item.nextDue - input.now;
  const reviewHistory = item.reviewHistory;
  const lastReview = reviewHistory.at(-1);
  const latestAttempt = input.attempts?.at(-1);

  return {
    questionId: item.questionId,
    question: item.question,
    nextDue: item.nextDue,
    createdAt: item.createdAt,
    msUntilDue,
    status: msUntilDue <= 0 ? "now" : "scheduled",
    generatedFromQuestion: item.generatedFromQuestion,
    questionProvenance: item.questionProvenance,
    reviewHistory,
    lastScore: latestAttempt?.score ?? lastReview?.score ?? null,
    lastAnswer: item.lastAnswer ?? latestAttempt?.rawAnswer ?? null,
    lastAnswerSummary:
      item.lastAnswerSummary ?? latestAttempt?.answerSummary ?? null,
    conciseAnswer:
      item.conciseAnswer ?? latestAttempt?.correctAnswer ?? null,
    lastJustification: latestAttempt?.justification ?? null,
    attempts: input.attempts ?? [],
    conceptSlugs: item.conceptSlugs,
  };
}

export async function loadReviewSessionQueue(input: {
  userId: string;
  excludeQuestionIds?: string[];
  limit?: number;
  offset?: number;
}): Promise<ReviewSessionQueueResponse> {
  const now = Date.now();
  const limit = Math.min(
    REVIEW_SESSION_QUEUE_LIMIT,
    Math.max(0, Math.floor(input.limit ?? REVIEW_SESSION_QUEUE_LIMIT)),
  );
  const activeEvaluationQuestionIds = await getActiveAnswerEvaluationQuestionIds({
    userId: input.userId,
    activeSince: now - ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS,
  });
  const excludeQuestionIds = Array.from(
    new Set([...(input.excludeQuestionIds ?? []), ...activeEvaluationQuestionIds]),
  );
  const dueQuestions = await getDueQuestions(now, {
    userId: input.userId,
    excludeQuestionIds,
    limit,
    offset: input.offset,
  });

  return {
    items: dueQuestions.map((item) => toReviewQueueItem(item, { now })),
  };
}

function persistEvaluationFailure(
  evaluationId: string,
  result: EvaluationResult,
  resolvedAt = Date.now(),
): void {
  void resolveAnswerEvaluationRecord({
    id: evaluationId,
    score: result.score,
    justification: result.justification,
    answerSummary: result.answerSummary,
    nextDue: null,
    resolvedAt,
  }).catch((error: unknown) => {
    console.info("[waxon] failed to persist evaluation failure status", {
      evaluationId,
      error: error instanceof Error ? error.message : "unknown error",
    });
  });
}

async function persistEvaluationResolution(input: {
  evaluationId: string;
  result: EvaluationResult;
  nextDue: number | null;
  resolvedAt: number;
}): Promise<void> {
  try {
    await resolveAnswerEvaluationRecord({
      id: input.evaluationId,
      score: input.result.score,
      justification: input.result.justification,
      answerSummary: input.result.answerSummary,
      nextDue: input.nextDue,
      resolvedAt: input.resolvedAt,
    });
  } catch (error) {
    console.info("[waxon] failed to persist evaluation resolution status", {
      evaluationId: input.evaluationId,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function processEvaluation(submission: Submission): Promise<void> {
  const startedAt = Date.now();
  let currentPhase: EvaluationPhase = "queued";
  let phaseStartedAt = startedAt;
  let isFinished = false;
  let savedEvaluationResult: EvaluationResult | null = null;
  let savedEvaluationNextDue: number | null = null;
  const phaseTimingsMs: Partial<Record<EvaluationPhase, number>> = {};
  let lastPersistedActivityAt = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  const resetWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (savedEvaluationResult) {
        finishEvaluation(savedEvaluationResult, savedEvaluationNextDue, {
          logAction: "evaluation-finished-before-enrichment-timeout",
        });
        return;
      }

      finishEvaluation(
        failedEvaluation(
          `Evaluation timed out during ${currentPhase} after ${Math.round(
            EVALUATION_PROCESSING_TIMEOUT_MS / 1000,
          )}s without evaluator activity.`,
          submission.answer,
        ),
        null,
        {
          logAction: "evaluation-timeout",
        },
      );
    }, EVALUATION_PROCESSING_TIMEOUT_MS);
  };
  const setPhase = (phase: EvaluationPhase) => {
    phaseTimingsMs[currentPhase] =
      (phaseTimingsMs[currentPhase] ?? 0) + Date.now() - phaseStartedAt;
    currentPhase = phase;
    phaseStartedAt = Date.now();
    resetWatchdog();
    void updateAnswerEvaluationPhase({
      id: submission.evaluationId,
      phase,
    });
  };
  const markActivity = () => {
    resetWatchdog();
    const now = Date.now();

    if (now - lastPersistedActivityAt < 1_000) {
      return;
    }

    lastPersistedActivityAt = now;
    void updateAnswerEvaluationPhase({
      id: submission.evaluationId,
      phase: currentPhase,
      now,
    });
  };
  const finishEvaluation = (
    result: EvaluationResult,
    nextDue: number | null,
    options: {
      logAction: string;
      error?: unknown;
    },
  ) => {
    if (isFinished) {
      console.info("[waxon] late evaluation completion ignored", {
        action: options.logAction,
        evaluationId: submission.evaluationId,
        question: submission.question,
        phase: currentPhase,
        elapsedMs: Date.now() - startedAt,
      });
      return false;
    }

    isFinished = true;
    clearWatchdog();
    phaseTimingsMs[currentPhase] =
      (phaseTimingsMs[currentPhase] ?? 0) + Date.now() - phaseStartedAt;

    if (result.status === "failed") {
      persistEvaluationFailure(submission.evaluationId, result);
    }

    if (options.error !== undefined || result.status === "failed") {
      console.info("[waxon] evaluation resolved without grading", {
        action: options.logAction,
        evaluationId: submission.evaluationId,
        question: submission.question,
        phase: currentPhase,
        elapsedMs: Date.now() - startedAt,
        reason: result.justification,
        error:
          options.error instanceof Error
            ? options.error.message
            : options.error === undefined
              ? undefined
              : "unknown error",
      });
    }

    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs > 10_000 || options.logAction !== "evaluation-finished") {
      console.info("[waxon] evaluation timing", {
        action: options.logAction,
        evaluationId: submission.evaluationId,
        question: submission.question,
        elapsedMs,
        phaseTimingsMs,
      });
    }

    return true;
  };
  resetWatchdog();

  try {
    setPhase("evaluating-answer");
    const result = await evaluateAnswer({
      question: submission.question,
      answer: submission.answer,
      previousReviews: submission.previousReviews,
      expectedAnswer: submission.expectedAnswer,
      userId: submission.userId,
      traceId: submission.traceId,
      onActivity: markActivity,
    });

    if (isFinished) {
      return;
    }

    if (result.status === "failed") {
      finishEvaluation(result, null, {
        logAction: "evaluation-failed",
      });
      return;
    }

    const resolvedAt = Date.now();
    savedEvaluationResult = result;
    setPhase("saving-evaluation");
    const persisted = await applyEvaluationToPostgres({
      questionId: submission.questionId ?? undefined,
      question: submission.question,
      answer: submission.answer,
      answerSummary: result.answerSummary,
      correctAnswer: result.correctAnswer,
      justification: result.justification,
      score: result.score,
      submittedAt: submission.submittedAt,
      now: resolvedAt,
      userId: submission.userId,
    });

    if (isFinished) {
      return;
    }

    if (persisted) {
      const evaluationNextDue = persisted.nextDue;

      await persistEvaluationResolution({
        evaluationId: submission.evaluationId,
        result,
        nextDue: evaluationNextDue,
        resolvedAt,
      });
      savedEvaluationNextDue = evaluationNextDue;

    } else {
      await persistEvaluationResolution({
        evaluationId: submission.evaluationId,
        result,
        nextDue: null,
        resolvedAt,
      });
    }

    setPhase("finalizing");
    finishEvaluation(result, savedEvaluationNextDue, {
      logAction: "evaluation-finished",
    });
  } catch (error) {
    finishEvaluation(
      failedEvaluation(
        `Evaluation failed during ${currentPhase} before it could be saved.`,
        submission.answer,
      ),
      null,
      {
        logAction: "evaluation-processing-failed",
        error,
      },
    );
  }
}

export async function flagQuestion(input: {
  userId: string;
  questionId: string;
  question: string;
}): Promise<void> {
  await flagQuestionForReview({
    userId: input.userId,
    questionId: input.questionId,
    question: input.question,
  });

}

export async function submitAnswer(input: {
  userId: string;
  questionId: string;
  question: string;
  answer: string;
}): Promise<{ evaluationId: string; traceId: string }> {
  const requestedQuestionId = input.questionId.trim();

  if (!requestedQuestionId) {
    throw new Error("questionId is required.");
  }

  const snapshot = await getQuestionSnapshotById(requestedQuestionId, {
    userId: input.userId,
  });

  if (!snapshot) {
    throw new Error("Question not found.");
  }

  if (
    !(await questionHasActiveConceptTag({
      userId: input.userId,
      questionId: snapshot.questionId,
    }))
  ) {
    throw new Error("Question is not in review.");
  }

  if (snapshot.flaggedAt !== null) {
    throw new Error("Question has been flagged.");
  }

  const normalizedInputQuestion = input.question.trim().replace(/\s+/g, " ");
  const normalizedSnapshotQuestion = snapshot.question.trim().replace(/\s+/g, " ");

  if (normalizedInputQuestion !== normalizedSnapshotQuestion) {
    throw new Error("Question mismatch.");
  }

  const submittedAt = Date.now();
  const traceId = crypto.randomUUID();
  const questionId = snapshot.questionId;
  const evaluationId = `${submittedAt}-${Math.random().toString(36).slice(2, 10)}`;

  await recordPendingLlmTrace({
    traceId,
    operation: "evaluate_answer",
    model: "pending-evaluation",
    question: snapshot.question,
    requestBody: {
      evaluationId,
      questionId,
      submittedAt,
    },
  });
  await createAnswerEvaluationRecord({
    id: evaluationId,
    traceId,
    userId: snapshot.userId,
    question: snapshot.question,
    answer: input.answer,
    submittedAt,
  });
  const submission = {
    evaluationId,
    traceId,
    questionId,
    question: snapshot.question,
    userId: snapshot.userId,
    answer: input.answer,
    expectedAnswer: snapshot.conciseAnswer || null,
    submittedAt,
    previousReviews: serializeReviews(snapshot.reviewHistory),
  } satisfies Submission;

  after(() => processEvaluation(submission));

  return {
    evaluationId,
    traceId,
  };
}

export async function reviewSummaryForUser(
  userId: string,
): Promise<ReviewSummary> {
  const now = Date.now();
  const excludeQuestionIds = await getActiveAnswerEvaluationQuestionIds({
    userId,
    activeSince: now - ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS,
  });
  const [queueRemaining, nextScheduledDue] = await Promise.all([
    countDueQuestions(now, { userId }),
    getNextScheduledQuestionDue(now, { userId, excludeQuestionIds }),
  ]);

  return {
    queueRemaining,
    nextScheduledDue,
  };
}

export async function reviewActivityForUser(
  userId: string,
  input: { recentAttemptsLimit?: number } = {},
): Promise<ReviewActivity> {
  const now = Date.now();
  const [summary, recentAttempts, persistedEvaluations] = await Promise.all([
    reviewSummaryForUser(userId),
    getRecentQuestionAttempts({
      userId,
      limit: Math.max(0, Math.floor(input.recentAttemptsLimit ?? 24)),
    }),
    getVisibleAnswerEvaluations({
      userId,
      activeSince: now - ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS,
      resolvedSince: now - RESOLVED_JUDGING_VISIBLE_MS,
      limit: 50,
    }),
  ]);

  return {
    ...summary,
    pendingEvaluations: persistedEvaluations.filter(
      (evaluation) => evaluation.status === "grading",
    ).length,
    evaluations: persistedEvaluations.toReversed(),
    recentAttempts,
  };
}
