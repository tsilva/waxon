import {
  applyEvaluationToPostgres,
  getAllQueuedQuestions,
  getDueQuestions,
  getQuestionAttempts,
  getQuestionSnapshot,
  readQuestionsWithEmbeddings,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
  type DueQuestion,
  type QuestionInput,
  type QuestionAttempt,
} from "./postgresStore";
import {
  evaluateAnswer,
  PROBING_QUESTION_SCORE_THRESHOLD,
  type EvaluationResult,
} from "./evaluateAnswer";
import { parseReviews, reinsertionDelay, type ReviewEntry } from "./scheduler";
import {
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddingSource";
import { getCurrentUser } from "./auth";
import { gateNovelQuestions } from "./semanticDedupe";

export const RESOLVED_JUDGING_VISIBLE_MS = 10_000;
const DEFAULT_DECK_ID = "deep-learning";

type Submission = {
  evaluationId: string;
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
  reviewQueue: ReviewQueueItem[];
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

  if (result.status === "graded") {
    state.latestByQuestion[item.question] = {
      score: result.score,
      justification: result.justification,
      answerSummary: result.answerSummary,
      resolvedAt: item.resolvedAt,
    };
  }
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

async function getDeckEmbeddingPlot(): Promise<DeckEmbeddingPlot> {
  const questions = await readQuestionsWithEmbeddings();
  const totalQuestions = questions.length;
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

async function getReviewQueueItems(now = Date.now()): Promise<ReviewQueueItem[]> {
  const queuedQuestions = await getAllQueuedQuestions();
  const attemptsByQuestion = new Map(
    await Promise.all(
      queuedQuestions.map(async (item) => [
        item.question,
        await getQuestionAttempts(item.question),
      ] as const),
    ),
  );

  return queuedQuestions
    .filter((item) => !state.inFlightQuestions.has(item.question))
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
  try {
    const result = await evaluateAnswer({
      question: submission.question,
      answer: submission.answer,
      previousReviews: submission.previousReviews,
      userId: submission.userId,
      deckId: submission.deckId,
    });

    if (result.status === "failed") {
      restoreFailedQuestion(submission.queuedQuestion);
      resolveEvaluationItem(submission.evaluationId, result, null);
      return;
    }

    const resolvedAt = Date.now();
    const persisted = await applyEvaluationToPostgres({
      question: submission.question,
      answer: submission.answer,
      answerSummary: result.answerSummary,
      justification: result.justification,
      score: result.score,
      submittedAt: submission.submittedAt,
      now: resolvedAt,
    });

    if (persisted) {
      if (
        result.score <= PROBING_QUESTION_SCORE_THRESHOLD &&
        result.probingQuestions.length > 0
      ) {
        try {
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
          const probingQuestions = await upsertDueQuestions({
            questions: gateResult.accepted.map((candidate) => ({
              question: candidate.question,
              conciseAnswer: candidate.conciseAnswer,
            })),
            sourceQuestion: submission.question,
            now: resolvedAt,
          });

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
          });

          enqueueProbingQuestions(probingQuestions);
        } catch (error) {
          console.info("[waxon] probing question insertion failed", {
            question: submission.question,
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
    queuedQuestion: queued,
    userId: snapshot?.userId ?? null,
    deckId: snapshot?.deckId ?? null,
    answer: input.answer,
    submittedAt,
    previousReviews: snapshot?.reviews ?? "",
  });

  return {
    evaluationId: evaluation.id,
  };
}

export async function addQuestionsToDeck(input: {
  questions: Array<string | QuestionInput>;
}): Promise<{ added: number; rejected: number }> {
  await initializeQueue();

  const user = getCurrentUser();
  const gateResult = await gateNovelQuestions(input.questions, {
    operation: "add_questions_gate",
    userId: user.id,
    deckId: DEFAULT_DECK_ID,
  });

  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
    })),
    sourceQuestion: null,
    now: Date.now(),
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
  });

  enqueueProbingQuestions(addedQuestions);
  void broadcastQueueStatus();

  return {
    added: addedQuestions.length,
    rejected: gateResult.rejected.length,
  };
}

export async function queueStatus(): Promise<QueueStatusSnapshot> {
  await initializeQueue();
  await refreshIfEmpty();
  const [reviewQueue, deckEmbeddingPlot] = await Promise.all([
    getReviewQueueItems(),
    getDeckEmbeddingPlot(),
  ]);

  return {
    queueRemaining: state.queue.length,
    pendingEvaluations: state.pendingEvaluations,
    evaluations: getVisibleEvaluations(),
    reviewQueue,
    deckEmbeddingPlot,
  };
}
