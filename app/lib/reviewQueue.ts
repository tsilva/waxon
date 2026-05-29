import {
  applyEvaluationToSqlite,
  getAllQueuedQuestions,
  getDueQuestions,
  getQuestionSnapshot,
  type DueQuestion,
} from "./sqliteStore";
import { evaluateAnswer, type EvaluationResult } from "./evaluateAnswer";
import { parseReviews, reinsertionDelay, type ReviewEntry } from "./scheduler";

export const RESOLVED_JUDGING_VISIBLE_MS = 10_000;

type Submission = {
  evaluationId: string;
  question: string;
  answer: string;
  submittedAt: number;
  previousReviews: string;
};

export type EvaluationQueueItem = {
  id: string;
  question: string;
  status: "grading" | "resolved";
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
};

export type ReviewQueueItem = {
  question: string;
  nextDue: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  reviewHistory: ReviewEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
};

export type QueueStatusSnapshot = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  reviewQueue: ReviewQueueItem[];
};

type QueueStatusSubscriber = (status: QueueStatusSnapshot) => void;

type LatestEvaluation = {
  score: number;
  justification: string;
  answerSummary: string;
  resolvedAt: number;
};

type QueueState = {
  initialized: boolean;
  initializing: Promise<void> | null;
  queue: DueQuestion[];
  pendingEvaluations: number;
  inFlightQuestions: Set<string>;
  evaluations: EvaluationQueueItem[];
  latestByQuestion: Record<string, LatestEvaluation>;
  subscribers: Set<QueueStatusSubscriber>;
};

const globalForQueue = globalThis as typeof globalThis & {
  waxonQueue?: QueueState;
};

const state: QueueState =
  globalForQueue.waxonQueue ??
  {
    initialized: false,
    initializing: null,
    queue: [],
    pendingEvaluations: 0,
    inFlightQuestions: new Set<string>(),
    evaluations: [],
    latestByQuestion: {},
    subscribers: new Set<QueueStatusSubscriber>(),
  };

globalForQueue.waxonQueue = state;
state.latestByQuestion ??= {};
state.subscribers ??= new Set<QueueStatusSubscriber>();

function logQueueFlushStatus(action: string): void {
  console.info("[waxon] queue flush status", {
    action,
    queueRemaining: state.queue.length,
    pendingEvaluations: state.pendingEvaluations,
    inFlightQuestions: state.inFlightQuestions.size,
    evaluationsTracked: state.evaluations.length,
    initialized: state.initialized,
  });
}

async function broadcastQueueStatus(): Promise<void> {
  if (state.subscribers.size === 0) {
    return;
  }

  let status: QueueStatusSnapshot;

  try {
    status = await queueStatus();
  } catch {
    return;
  }

  for (const subscriber of state.subscribers) {
    subscriber(status);
  }
}

export function subscribeQueueStatus(
  subscriber: QueueStatusSubscriber,
): () => void {
  state.subscribers.add(subscriber);

  return () => {
    state.subscribers.delete(subscriber);
  };
}

function createEvaluationItem(input: {
  question: string;
  submittedAt: number;
}): EvaluationQueueItem {
  const id = `${input.submittedAt}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    question: input.question,
    status: "grading",
    submittedAt: input.submittedAt,
    score: null,
    justification: null,
    answerSummary: null,
    resolvedAt: null,
    nextDue: null,
  };
}

function resolveEvaluationItem(
  evaluationId: string,
  result: EvaluationResult,
  nextDue: number | null,
): void {
  const item = state.evaluations.find(
    (evaluation) => evaluation.id === evaluationId,
  );

  if (!item) {
    return;
  }

  item.status = "resolved";
  item.score = result.score;
  item.justification = result.justification;
  item.answerSummary = result.answerSummary;
  item.resolvedAt = Date.now();
  item.nextDue = nextDue;
  state.latestByQuestion[item.question] = {
    score: result.score,
    justification: result.justification,
    answerSummary: result.answerSummary,
    resolvedAt: item.resolvedAt,
  };
}

function getVisibleEvaluations(now = Date.now()): EvaluationQueueItem[] {
  state.evaluations = state.evaluations.filter(
    (evaluation) =>
      evaluation.status === "grading" ||
      evaluation.resolvedAt === null ||
      now - evaluation.resolvedAt < RESOLVED_JUDGING_VISIBLE_MS,
  );

  return state.evaluations;
}

async function getReviewQueueItems(now = Date.now()): Promise<ReviewQueueItem[]> {
  const queuedQuestions = await getAllQueuedQuestions();

  return queuedQuestions
    .filter((item) => !state.inFlightQuestions.has(item.question))
    .map((item) => {
      const msUntilDue = item.nextDue - now;
      const latest = state.latestByQuestion[item.question];
      const reviewHistory = parseReviews(item.reviews);
      const lastReview = reviewHistory.at(-1);

      return {
        question: item.question,
        nextDue: item.nextDue,
        msUntilDue,
        status: msUntilDue <= 0 ? "now" : "scheduled",
        reviewHistory,
        lastScore: latest?.score ?? lastReview?.score ?? null,
        lastAnswer: item.lastAnswer,
        lastAnswerSummary: latest?.answerSummary ?? item.lastAnswerSummary,
        referenceAnswer: item.referenceAnswer,
        lastJustification: latest?.justification ?? null,
      } satisfies ReviewQueueItem;
    })
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "now" ? -1 : 1;
      }

      return a.nextDue - b.nextDue;
    });
}

async function initializeQueue(): Promise<void> {
  if (state.initialized) {
    return;
  }

  if (!state.initializing) {
    state.initializing = getDueQuestions().then((dueQuestions) => {
      state.queue = dueQuestions;
      state.initialized = true;
      state.initializing = null;
      logQueueFlushStatus("initialized");
    });
  }

  await state.initializing;
}

async function refreshIfEmpty(): Promise<void> {
  if (state.queue.length > 0) {
    return;
  }

  const dueQuestions = await getDueQuestions();
  state.queue = dueQuestions.filter(
    (question) => !state.inFlightQuestions.has(question.question),
  );
  logQueueFlushStatus("refreshed-empty-queue");
}

function removeFromQueue(question: string): DueQuestion | null {
  const index = state.queue.findIndex((item) => item.question === question);

  if (index === -1) {
    return null;
  }

  const [removed] = state.queue.splice(index, 1);
  return removed ?? null;
}

function reinsertQuestion(question: DueQuestion, score: number): void {
  const delay = reinsertionDelay(score);

  if (delay === null) {
    return;
  }

  state.queue = state.queue.filter((item) => item.question !== question.question);
  const index = Math.min(delay, state.queue.length);
  state.queue.splice(index, 0, question);
  logQueueFlushStatus("reinserted-low-score");
}

async function processEvaluation(submission: Submission): Promise<void> {
  try {
    const result = await evaluateAnswer({
      question: submission.question,
      answer: submission.answer,
      previousReviews: submission.previousReviews,
    });
    const persisted = await applyEvaluationToSqlite({
      question: submission.question,
      answer: submission.answer,
      answerSummary: result.answerSummary,
      justification: result.justification,
      score: result.score,
      submittedAt: submission.submittedAt,
      now: Date.now(),
    });

    if (persisted) {
      reinsertQuestion(
        {
          question: persisted.question,
          reviews: persisted.reviews,
          nextDue: persisted.nextDue,
          lastAnswer: persisted.lastAnswer,
          lastAnswerSummary: persisted.lastAnswerSummary,
          referenceAnswer: persisted.referenceAnswer,
        },
        result.score,
      );
    }

    resolveEvaluationItem(submission.evaluationId, result, persisted?.nextDue ?? null);
  } finally {
    state.pendingEvaluations = Math.max(0, state.pendingEvaluations - 1);
    state.inFlightQuestions.delete(submission.question);
    logQueueFlushStatus("evaluation-finished");
    void broadcastQueueStatus();
  }
}

export async function peekNextQuestion(): Promise<{
  question: string | null;
  queueRemaining: number;
}> {
  await initializeQueue();
  await refreshIfEmpty();

  return {
    question: state.queue[0]?.question ?? null,
    queueRemaining: state.queue.length,
  };
}

export async function skipQuestion(input: {
  question: string;
}): Promise<{ question: string | null; queueRemaining: number }> {
  await initializeQueue();
  await refreshIfEmpty();

  const skipped = removeFromQueue(input.question);

  if (skipped) {
    state.queue.push(skipped);
    logQueueFlushStatus("skipped-question");
    void broadcastQueueStatus();
  }

  return peekNextQuestion();
}

export async function submitAnswer(input: {
  question: string;
  answer: string;
}): Promise<{ evaluationId: string }> {
  await initializeQueue();

  const queued = removeFromQueue(input.question);
  const snapshot = queued ?? (await getQuestionSnapshot(input.question));
  const submittedAt = Date.now();
  const evaluation = createEvaluationItem({
    question: input.question,
    submittedAt,
  });

  state.evaluations = [...state.evaluations, evaluation].slice(-50);
  state.pendingEvaluations += 1;
  state.inFlightQuestions.add(input.question);
  logQueueFlushStatus("submitted-answer");
  void broadcastQueueStatus();

  void processEvaluation({
    evaluationId: evaluation.id,
    question: input.question,
    answer: input.answer,
    submittedAt,
    previousReviews: snapshot?.reviews ?? "",
  });

  return {
    evaluationId: evaluation.id,
  };
}

export async function queueStatus(): Promise<QueueStatusSnapshot> {
  await initializeQueue();
  await refreshIfEmpty();

  return {
    queueRemaining: state.queue.length,
    pendingEvaluations: state.pendingEvaluations,
    evaluations: getVisibleEvaluations(),
    reviewQueue: await getReviewQueueItems(),
  };
}
