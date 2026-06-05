import {
  applyEvaluationToPostgres,
  getDueQuestions,
  getQuestionAttempts,
  getQueuedQuestionsPage,
  getRecentQuestionAttempts,
  getQuestionSnapshot,
  readQuestionsWithEmbeddings,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
  type DueQuestion,
  type QuestionInput,
  type QuestionAttempt,
  type QueuedQuestionsSortKey,
} from "./postgresStore";
import {
  evaluateAnswer,
  EVALUATION_TIMEOUT_MS,
  failedEvaluation,
  PROBING_QUESTION_SCORE_THRESHOLD,
  type EvaluationResult,
} from "./evaluateAnswer";
import { parseReviews, reinsertionDelay, type ReviewEntry } from "./scheduler";
import {
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddingSource";
import {
  getCurrentUser,
  getDeckIdForUser,
  type AuthenticatedUser,
} from "./auth";
import { gateNovelQuestions } from "./semanticDedupe";

export const RESOLVED_JUDGING_VISIBLE_MS = 10_000;
const EVALUATION_PROCESSING_TIMEOUT_MS = EVALUATION_TIMEOUT_MS;

type EvaluationPhase =
  | "queued"
  | "evaluating-answer"
  | "saving-evaluation"
  | "gating-probes"
  | "saving-probes"
  | "finalizing";

type Submission = {
  evaluationId: string;
  traceId: string;
  question: string;
  queuedQuestion: DueQuestion | null;
  userId: string | null;
  deckId: string | null;
  answer: string;
  submittedAt: number;
  previousReviews: string;
};

export type EvaluationQueueItem = {
  id: string;
  traceId: string;
  question: string;
  answer: string;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
};

export type ReviewQueueItem = {
  deckId: string;
  deckName: string;
  question: string;
  nextDue: number;
  createdAt: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  generatedFromQuestion: string | null;
  reviewHistory: ReviewEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
  attempts: QuestionAttempt[];
};

export type DeckEmbeddingPlotPoint = {
  question: string;
  lastScore: number | null;
  x: number;
  y: number;
};

export type DeckEmbeddingPlot = {
  model: string | null;
  totalQuestions: number;
  embeddedQuestions: number;
  points: DeckEmbeddingPlotPoint[];
};

export type QueueStatusSnapshot = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal: number;
  reviewQueueOffset: number;
  reviewQueueLimit: number;
  reviewQueueHasMore: boolean;
  deckEmbeddingPlot: DeckEmbeddingPlot;
};

type QueueStatusSubscriber = (status: QueueStatusSnapshot) => void;

type LatestEvaluation = {
  score: number;
  justification: string;
  answerSummary: string;
  resolvedAt: number;
};

type QueueState = {
  userId: string | null;
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
    userId: null,
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
state.userId ??= null;
state.latestByQuestion ??= {};
state.subscribers ??= new Set<QueueStatusSubscriber>();

function resetQueueStateForUser(userId: string): void {
  state.userId = userId;
  state.initialized = false;
  state.initializing = null;
  state.queue = [];
  state.pendingEvaluations = 0;
  state.inFlightQuestions = new Set();
  state.evaluations = [];
  state.latestByQuestion = {};
}

async function ensureQueueUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();

  if (state.userId !== user.id) {
    resetQueueStateForUser(user.id);
  }

  return user;
}

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
  traceId: string;
  question: string;
  answer: string;
  submittedAt: number;
}): EvaluationQueueItem {
  const id = `${input.submittedAt}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    traceId: input.traceId,
    question: input.question,
    answer: input.answer,
    status: "grading",
    phase: "queued",
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
  item.phase = null;
  item.score = result.score;
  item.justification = result.justification;
  item.answerSummary = result.answerSummary;
  item.resolvedAt = Date.now();
  item.nextDue = nextDue;

  if (result.status === "graded") {
    state.latestByQuestion[item.question] = {
      score: result.score,
      justification: result.justification,
      answerSummary: result.answerSummary,
      resolvedAt: item.resolvedAt,
    };
  }
}

function updateEvaluationPhase(
  evaluationId: string,
  phase: EvaluationPhase,
): void {
  const item = state.evaluations.find(
    (evaluation) => evaluation.id === evaluationId,
  );

  if (!item || item.status !== "grading" || item.phase === phase) {
    return;
  }

  item.phase = phase;
  void broadcastQueueStatus();
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

function dotProduct(a: number[], b: number[]): number {
  let total = 0;

  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return total;
}

function normalizeVector(vector: number[]): number[] | null {
  let squaredNorm = 0;

  for (const component of vector) {
    squaredNorm += component * component;
  }

  const norm = Math.sqrt(squaredNorm);

  if (norm <= Number.EPSILON) {
    return null;
  }

  return vector.map((component) => component / norm);
}

function initialComponent(dimensions: number, seed: number): number[] {
  return normalizeVector(
    Array.from({ length: dimensions }, (_, index) =>
      Math.sin((index + 1) * seed) + Math.cos((index + 1) * (seed + 0.37)),
    ),
  ) ?? Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
}

function principalComponent(
  rows: number[][],
  dimensions: number,
  seed: number,
  previousComponent?: number[],
): number[] | null {
  let component = initialComponent(dimensions, seed);

  if (previousComponent) {
    const overlap = dotProduct(component, previousComponent);
    component = component.map(
      (value, index) => value - overlap * (previousComponent[index] ?? 0),
    );
    component = normalizeVector(component) ?? initialComponent(dimensions, seed + 1);
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = Array.from({ length: dimensions }, () => 0);

    for (const row of rows) {
      const score = dotProduct(row, component);

      for (let index = 0; index < dimensions; index += 1) {
        next[index] += (row[index] ?? 0) * score;
      }
    }

    if (previousComponent) {
      const overlap = dotProduct(next, previousComponent);

      for (let index = 0; index < dimensions; index += 1) {
        next[index] -= overlap * (previousComponent[index] ?? 0);
      }
    }

    const normalized = normalizeVector(next);

    if (!normalized) {
      return null;
    }

    component = normalized;
  }

  return component;
}

function normalizeProjectionValue(value: number, min: number, max: number): number {
  if (max - min <= Number.EPSILON) {
    return 0.5;
  }

  return (value - min) / (max - min);
}

function projectEmbeddings(
  rows: Array<{ question: string; lastScore: number | null; embedding: number[] }>,
): DeckEmbeddingPlotPoint[] {
  if (rows.length === 0) {
    return [];
  }

  if (rows.length === 1) {
    return [
      {
        question: rows[0]?.question ?? "",
        lastScore: rows[0]?.lastScore ?? null,
        x: 0.5,
        y: 0.5,
      },
    ];
  }

  const dimensions = rows[0]?.embedding.length ?? 0;
  const means = Array.from({ length: dimensions }, (_, dimension) => {
    const total = rows.reduce(
      (sum, row) => sum + (row.embedding[dimension] ?? 0),
      0,
    );

    return total / rows.length;
  });
  const centered = rows.map((row) =>
    row.embedding.map((component, dimension) => component - means[dimension]),
  );
  const firstComponent = principalComponent(centered, dimensions, 1.41);
  const secondComponent = firstComponent
    ? principalComponent(centered, dimensions, 2.73, firstComponent)
    : null;
  const projected = centered.map((row, index) => ({
    question: rows[index]?.question ?? "",
    lastScore: rows[index]?.lastScore ?? null,
    rawX: firstComponent ? dotProduct(row, firstComponent) : index,
    rawY: secondComponent ? dotProduct(row, secondComponent) : 0,
  }));
  const xValues = projected.map((point) => point.rawX);
  const yValues = projected.map((point) => point.rawY);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return projected.map((point) => ({
    question: point.question,
    lastScore: point.lastScore,
    x: normalizeProjectionValue(point.rawX, minX, maxX),
    y: normalizeProjectionValue(point.rawY, minY, maxY),
  }));
}

async function getDeckEmbeddingPlot(input: {
  deckId?: string;
  questions: string[];
  totalQuestions: number;
  userId: string;
}): Promise<DeckEmbeddingPlot> {
  const questions = await readQuestionsWithEmbeddings({
    deckId: input.deckId,
    userId: input.userId,
    questions: input.questions,
  });
  const totalQuestions = input.totalQuestions;
  const modelCounts = new Map<string, number>();
  const preferredEmbeddings = questions.flatMap((question) =>
    question.embeddings.filter(
      (candidate) =>
        candidate.embeddingKind === DEDUPE_EMBEDDING_KIND && candidate.isCurrent,
    ),
  );
  const embeddingsForModelSelection =
    preferredEmbeddings.length > 0
      ? preferredEmbeddings
      : questions.flatMap((question) => question.embeddings);

  for (const embedding of embeddingsForModelSelection) {
    modelCounts.set(
      embedding.embeddingModel,
      (modelCounts.get(embedding.embeddingModel) ?? 0) + 1,
    );
  }

  const model = Array.from(modelCounts.entries()).sort(
    ([modelA, countA], [modelB, countB]) => countB - countA || modelA.localeCompare(modelB),
  )[0]?.[0] ?? null;

  if (!model) {
    return {
      model: null,
      totalQuestions,
      embeddedQuestions: 0,
      points: [],
    };
  }

  const selectedEmbeddings = questions
    .map((question) => {
      const embedding =
        question.embeddings.find(
          (candidate) =>
            candidate.embeddingModel === model &&
            candidate.embeddingKind === DEDUPE_EMBEDDING_KIND &&
            candidate.isCurrent,
        ) ??
        question.embeddings.find(
          (candidate) => candidate.embeddingModel === model,
        );

      return embedding
        ? {
            question: question.question,
            lastScore: parseReviews(question.reviews).at(-1)?.score ?? null,
            embedding: embedding.embedding,
          }
        : null;
    })
    .filter(
      (item): item is {
        question: string;
        lastScore: number | null;
        embedding: number[];
      } =>
        item !== null &&
        item.embedding.length > 0 &&
        item.embedding.every(Number.isFinite),
    );
  const dimensionCounts = new Map<number, number>();

  for (const item of selectedEmbeddings) {
    dimensionCounts.set(
      item.embedding.length,
      (dimensionCounts.get(item.embedding.length) ?? 0) + 1,
    );
  }

  const dimension = Array.from(dimensionCounts.entries()).sort(
    ([dimensionA, countA], [dimensionB, countB]) =>
      countB - countA || dimensionB - dimensionA,
  )[0]?.[0] ?? 0;
  const projectableEmbeddings = selectedEmbeddings.filter(
    (item) => item.embedding.length === dimension,
  );

  return {
    model,
    totalQuestions,
    embeddedQuestions: projectableEmbeddings.length,
    points: projectEmbeddings(projectableEmbeddings),
  };
}

async function getReviewQueueItems(
  userId: string,
  input: {
    deckId?: string;
    limit: number;
    offset: number;
    sortKey: QueuedQuestionsSortKey;
  },
  now = Date.now(),
): Promise<{
  items: ReviewQueueItem[];
  total: number;
}> {
  const queuedQuestionsPage = await getQueuedQuestionsPage({
    userId,
    deckId: input.deckId,
    excludeQuestions: Array.from(state.inFlightQuestions),
    limit: input.limit,
    offset: input.offset,
    sortKey: input.sortKey,
  });
  const queuedQuestions = queuedQuestionsPage.items;
  const attemptsByQuestion = new Map(
    await Promise.all(
      queuedQuestions.map(async (item) => [
        item.question,
        await getQuestionAttempts(item.question, { userId }),
      ] as const),
    ),
  );

  return {
    total: queuedQuestionsPage.total,
    items: queuedQuestions
      .map((item) => {
        const msUntilDue = item.nextDue - now;
        const latest = state.latestByQuestion[item.question];
        const reviewHistory = parseReviews(item.reviews);
        const lastReview = reviewHistory.at(-1);

        return {
          deckId: item.deckId,
          deckName: item.deckName,
          question: item.question,
          nextDue: item.nextDue,
          createdAt: item.createdAt,
          msUntilDue,
          status: msUntilDue <= 0 ? "now" : "scheduled",
          generatedFromQuestion: item.generatedFromQuestion,
          reviewHistory,
          lastScore: latest?.score ?? lastReview?.score ?? null,
          lastAnswer: item.lastAnswer,
          lastAnswerSummary: latest?.answerSummary ?? item.lastAnswerSummary,
          conciseAnswer: item.conciseAnswer,
          referenceAnswer: item.referenceAnswer,
          lastJustification: latest?.justification ?? null,
          attempts: attemptsByQuestion.get(item.question) ?? [],
        } satisfies ReviewQueueItem;
      })
      .sort((a, b) => {
        if (input.sortKey === "creation-date") {
          return b.createdAt - a.createdAt || a.question.localeCompare(b.question);
        }

        return a.nextDue - b.nextDue || a.question.localeCompare(b.question);
      }),
  };
}

async function initializeQueue(): Promise<AuthenticatedUser> {
  const user = await ensureQueueUser();

  if (state.initialized) {
    return user;
  }

  if (!state.initializing) {
    state.initializing = getDueQuestions(Date.now(), { userId: user.id }).then((dueQuestions) => {
      state.queue = dueQuestions;
      state.initialized = true;
      state.initializing = null;
      logQueueFlushStatus("initialized");
    });
  }

  await state.initializing;
  return user;
}

async function refreshIfEmpty(userId: string): Promise<void> {
  if (state.queue.length > 0) {
    return;
  }

  const dueQuestions = await getDueQuestions(Date.now(), { userId });
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

function removeAllFromQueue(question: string): void {
  state.queue = state.queue.filter((item) => item.question !== question);
}

function reinsertQuestion(question: DueQuestion, score: number): void {
  const delay = reinsertionDelay(score);

  if (delay === null) {
    return;
  }

  state.queue = state.queue.filter((item) => item.question !== question.question);
  if (state.queue.length === 0) {
    logQueueFlushStatus("deferred-low-score-reinsertion");
    return;
  }

  const index = Math.min(delay, state.queue.length);
  state.queue.splice(index, 0, question);
  logQueueFlushStatus("reinserted-low-score");
}

function restoreFailedQuestion(question: DueQuestion | null): void {
  if (!question) {
    return;
  }

  state.queue = [
    question,
    ...state.queue.filter((item) => item.question !== question.question),
  ];
  logQueueFlushStatus("restored-failed-evaluation-question");
}

function enqueueProbingQuestions(probingQuestions: DueQuestion[]): void {
  if (probingQuestions.length === 0) {
    return;
  }

  const dueProbingQuestions = probingQuestions.filter(
    (question) => !state.inFlightQuestions.has(question.question),
  );

  if (dueProbingQuestions.length === 0) {
    return;
  }

  const probeQuestionText = new Set(
    dueProbingQuestions.map((question) => question.question),
  );

  state.queue = [
    ...dueProbingQuestions,
    ...state.queue.filter((question) => !probeQuestionText.has(question.question)),
  ];
  logQueueFlushStatus("queued-probing-questions");
}

async function processEvaluation(submission: Submission): Promise<void> {
  const startedAt = Date.now();
  let currentPhase: EvaluationPhase = "queued";
  let isFinished = false;
  const setPhase = (phase: EvaluationPhase) => {
    currentPhase = phase;
    updateEvaluationPhase(submission.evaluationId, phase);
  };
  const finishEvaluation = (
    result: EvaluationResult,
    nextDue: number | null,
    options: {
      restoreQuestion: boolean;
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
    clearTimeout(watchdog);

    if (options.restoreQuestion) {
      restoreFailedQuestion(submission.queuedQuestion);
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

    resolveEvaluationItem(submission.evaluationId, result, nextDue);
    state.pendingEvaluations = Math.max(0, state.pendingEvaluations - 1);
    state.inFlightQuestions.delete(submission.question);
    logQueueFlushStatus(options.logAction);
    void broadcastQueueStatus();
    return true;
  };
  const watchdog = setTimeout(() => {
    finishEvaluation(
      failedEvaluation(
        `Evaluation timed out during ${currentPhase} after ${Math.round(
          EVALUATION_PROCESSING_TIMEOUT_MS / 1000,
        )}s.`,
        submission.answer,
      ),
      null,
      {
        restoreQuestion: true,
        logAction: "evaluation-timeout",
      },
    );
  }, EVALUATION_PROCESSING_TIMEOUT_MS);

  try {
    setPhase("evaluating-answer");
    const result = await evaluateAnswer({
      question: submission.question,
      answer: submission.answer,
      previousReviews: submission.previousReviews,
      userId: submission.userId,
      deckId: submission.deckId,
      traceId: submission.traceId,
    });

    if (isFinished) {
      return;
    }

    if (result.status === "failed") {
      finishEvaluation(result, null, {
        restoreQuestion: true,
        logAction: "evaluation-failed",
      });
      return;
    }

    const resolvedAt = Date.now();
    setPhase("saving-evaluation");
    const persisted = await applyEvaluationToPostgres({
      question: submission.question,
      answer: submission.answer,
      answerSummary: result.answerSummary,
      justification: result.justification,
      score: result.score,
      submittedAt: submission.submittedAt,
      now: resolvedAt,
      userId: submission.userId ?? undefined,
    });

    if (isFinished) {
      return;
    }

    if (persisted) {
      removeAllFromQueue(submission.question);

      if (
        result.score <= PROBING_QUESTION_SCORE_THRESHOLD &&
        result.probingQuestions.length > 0
      ) {
        try {
          setPhase("gating-probes");
          const sourceQuestionKey = submission.question.trim().toLowerCase();
          const gateResult = await gateNovelQuestions(
            result.probingQuestions.filter(
              (question) => question.trim().toLowerCase() !== sourceQuestionKey,
            ),
            {
              operation: "probing_question_gate",
              userId: persisted.userId,
              deckId: persisted.deckId,
              question: submission.question,
            },
          );
          if (isFinished) {
            return;
          }

          setPhase("saving-probes");
          const probingQuestions = await upsertDueQuestions({
            questions: gateResult.accepted.map((candidate) => ({
              question: candidate.question,
              conciseAnswer: candidate.conciseAnswer,
            })),
            sourceQuestion: submission.question,
            now: resolvedAt,
            userId: persisted.userId,
          });

          if (isFinished) {
            return;
          }

          await upsertQuestionEmbeddings({
            embeddings: gateResult.accepted.map((candidate) => ({
              question: candidate.question,
              embeddingModel:
                process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
              embeddingKind: DEDUPE_EMBEDDING_KIND,
              sourceVersion: DEDUPE_SOURCE_VERSION,
              sourceHash: candidate.sourceHash,
              embedding: candidate.embedding,
            })),
            userId: persisted.userId,
          });

          if (isFinished) {
            return;
          }

          enqueueProbingQuestions(probingQuestions);
        } catch (error) {
          console.info("[waxon] probing question insertion failed", {
            question: submission.question,
            phase: currentPhase,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : "unknown error",
          });
        }
      }

      reinsertQuestion(
        {
          deckId: persisted.deckId,
          deckName: persisted.deckName,
          userId: persisted.userId,
          question: persisted.question,
          reviews: persisted.reviews,
          nextDue: persisted.nextDue,
          createdAt: persisted.createdAt,
          generatedFromQuestion: persisted.generatedFromQuestion,
          lastAnswer: persisted.lastAnswer,
          lastAnswerSummary: persisted.lastAnswerSummary,
          conciseAnswer: persisted.conciseAnswer,
          referenceAnswer: persisted.referenceAnswer,
        },
        result.score,
      );
    }

    setPhase("finalizing");
    finishEvaluation(result, persisted?.nextDue ?? null, {
      restoreQuestion: false,
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
        restoreQuestion: true,
        logAction: "evaluation-processing-failed",
        error,
      },
    );
  }
}

export async function peekNextQuestion(): Promise<{
  question: string | null;
  queueRemaining: number;
}>;
export async function peekNextQuestion(input: {
  excludeQuestion?: string | null;
}): Promise<{
  question: string | null;
  queueRemaining: number;
}>;
export async function peekNextQuestion(input: {
  excludeQuestion?: string | null;
} = {}): Promise<{
  question: string | null;
  queueRemaining: number;
}> {
  const user = await initializeQueue();
  await refreshIfEmpty(user.id);
  const excludedQuestion = input.excludeQuestion?.trim() || null;
  const nextQuestion =
    state.queue.find(
      (item) =>
        !state.inFlightQuestions.has(item.question) &&
        item.question !== excludedQuestion,
    ) ?? null;

  return {
    question: nextQuestion?.question ?? null,
    queueRemaining: state.queue.length,
  };
}

export async function skipQuestion(input: {
  question: string;
}): Promise<{ question: string | null; queueRemaining: number }> {
  const user = await initializeQueue();
  await refreshIfEmpty(user.id);

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
}): Promise<{ evaluationId: string; traceId: string }> {
  const user = await initializeQueue();

  const queued = removeFromQueue(input.question);
  const snapshot =
    queued ?? (await getQuestionSnapshot(input.question, { userId: user.id }));
  const submittedAt = Date.now();
  const traceId = crypto.randomUUID();
  const evaluation = createEvaluationItem({
    traceId,
    question: input.question,
    answer: input.answer,
    submittedAt,
  });

  state.evaluations = [...state.evaluations, evaluation].slice(-50);
  state.pendingEvaluations += 1;
  state.inFlightQuestions.add(input.question);
  logQueueFlushStatus("submitted-answer");
  void broadcastQueueStatus();

  void processEvaluation({
    evaluationId: evaluation.id,
    traceId,
    question: input.question,
    queuedQuestion: queued,
    userId: snapshot?.userId ?? user.id,
    deckId: snapshot?.deckId ?? getDeckIdForUser(user.id),
    answer: input.answer,
    submittedAt,
    previousReviews: snapshot?.reviews ?? "",
  });

  return {
    evaluationId: evaluation.id,
    traceId,
  };
}

export async function addQuestionsToDeck(input: {
  questions: Array<string | QuestionInput>;
}): Promise<{ added: number; rejected: number }> {
  const user = await initializeQueue();
  const deckId = getDeckIdForUser(user.id);

  const gateResult = await gateNovelQuestions(input.questions, {
    operation: "add_questions_gate",
    userId: user.id,
    deckId,
  });

  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
    })),
    sourceQuestion: null,
    now: Date.now(),
    userId: user.id,
  });

  await upsertQuestionEmbeddings({
    embeddings: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      embeddingModel: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      embeddingKind: DEDUPE_EMBEDDING_KIND,
      sourceVersion: DEDUPE_SOURCE_VERSION,
      sourceHash: candidate.sourceHash,
      embedding: candidate.embedding,
    })),
    userId: user.id,
  });

  enqueueProbingQuestions(addedQuestions);
  void broadcastQueueStatus();

  return {
    added: addedQuestions.length,
    rejected: gateResult.rejected.length,
  };
}

export async function queueStatus(input: {
  deckId?: string;
  limit?: number;
  offset?: number;
  sortKey?: QueuedQuestionsSortKey;
} = {}): Promise<QueueStatusSnapshot> {
  const user = await initializeQueue();
  await refreshIfEmpty(user.id);
  const limit = Math.min(2_000, Math.max(0, Math.floor(input.limit ?? 24)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const sortKey = input.sortKey ?? "review-date";
  const reviewQueuePage = await getReviewQueueItems(user.id, {
    deckId: input.deckId,
    limit,
    offset,
    sortKey,
  });
  const recentAttempts = await getRecentQuestionAttempts({
    userId: user.id,
    excludeQuestions: Array.from(state.inFlightQuestions),
    limit: 24,
  });
  const deckEmbeddingPlot = await getDeckEmbeddingPlot({
    userId: user.id,
    deckId: input.deckId,
    questions: reviewQueuePage.items.map((item) => item.question),
    totalQuestions: reviewQueuePage.total,
  });

  return {
    queueRemaining: state.queue.length,
    pendingEvaluations: state.pendingEvaluations,
    evaluations: getVisibleEvaluations(),
    recentAttempts,
    reviewQueue: reviewQueuePage.items,
    reviewQueueTotal: reviewQueuePage.total,
    reviewQueueOffset: offset,
    reviewQueueLimit: limit,
    reviewQueueHasMore:
      offset + reviewQueuePage.items.length < reviewQueuePage.total,
    deckEmbeddingPlot,
  };
}
