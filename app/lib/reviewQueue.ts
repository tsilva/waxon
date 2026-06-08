import { after } from "next/server";
import {
  applyEvaluationToPostgres,
  createAnswerEvaluationRecord,
  getDueQuestions,
  getVisibleAnswerEvaluations,
  getQuestionAttemptsByQuestionIds,
  getQueuedQuestionsPage,
  getQueuedQuestionsByEmbeddingProximityPage,
  getQuestionSnapshotById,
  getRecentQuestionAttempts,
  listDecks,
  resolveAnswerEvaluationRecord,
  readQuestionsWithEmbeddings,
  resolveOwnedDeckId,
  updateAnswerEvaluationPhase,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
  type DueQuestion,
  type QuestionInput,
  type QueuedQuestionsSortKey,
} from "./postgresStore";
import {
  evaluateAnswer,
  EVALUATION_TIMEOUT_MS,
  failedEvaluation,
  type EvaluationResult,
} from "./evaluateAnswer";
import { recordPendingLlmTrace } from "./llmTraceStore";
import { parseReviews } from "./scheduler";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
  normalizeEmbeddingText,
} from "./embeddingSource";
import {
  getCurrentUser,
  type AuthenticatedUser,
} from "./auth";
import { gateNovelQuestions } from "./semanticDedupe";
import {
  getOpenRouterApiKey,
  openRouterEmbeddings,
} from "./openRouter";
import type {
  DeckEmbeddingPlot,
  DeckEmbeddingPlotPoint,
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
  QueueStatusSnapshot,
  ReviewQueueItem,
} from "./reviewTypes";

export const RESOLVED_JUDGING_VISIBLE_MS = 5 * 60_000;
const EVALUATION_PROCESSING_TIMEOUT_MS = EVALUATION_TIMEOUT_MS;
const ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS = 5 * 60_000;
const QUEUE_SEARCH_TOP_K = 200;

type Submission = {
  evaluationId: string;
  traceId: string;
  questionId: string | null;
  question: string;
  queuedQuestion: DueQuestion | null;
  userId: string | null;
  deckId: string | null;
  answer: string;
  expectedAnswer: string | null;
  submittedAt: number;
  previousReviews: string;
};

type QueueStatusSubscriber = (status: QueueStatusSnapshot) => void;

type NextQuestionMode = "review" | "learn";

type NextQuestionInput = {
  mode?: NextQuestionMode;
  deckId?: string | null;
  excludeQuestionId?: string | null;
  excludeQuestion?: string | null;
};

type QueueStatusInput = {
  deckId?: string;
  limit?: number;
  offset?: number;
  sortKey?: QueuedQuestionsSortKey;
  query?: string;
  includeReviewQueue?: boolean;
  includeQuestionAttempts?: boolean;
  includeRecentAttempts?: boolean;
  includeDeckEmbeddingPlot?: boolean;
};

type LatestEvaluation = {
  score: number;
  justification: string;
  answerSummary: string;
  correctAnswer: string | null;
  resolvedAt: number;
};

type QueueState = {
  userId: string | null;
  initialized: boolean;
  initializing: Promise<void> | null;
  queue: DueQuestion[];
  pendingEvaluations: number;
  inFlightQuestionKeys: Set<string>;
  evaluations: EvaluationQueueItem[];
  latestByQuestionKey: Record<string, LatestEvaluation>;
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
    inFlightQuestionKeys: new Set<string>(),
    evaluations: [],
    latestByQuestionKey: {},
    subscribers: new Set<QueueStatusSubscriber>(),
  };

globalForQueue.waxonQueue = state;
const legacyState = state as QueueState & {
  inFlightQuestions?: Set<string>;
  latestByQuestion?: Record<string, LatestEvaluation>;
};
state.userId ??= null;
state.inFlightQuestionKeys ??= legacyState.inFlightQuestions ?? new Set<string>();
state.latestByQuestionKey ??= legacyState.latestByQuestion ?? {};
state.subscribers ??= new Set<QueueStatusSubscriber>();

function questionKey(input: {
  questionId?: string | null;
  question: string;
}): string {
  return input.questionId ?? `question:${input.question}`;
}

function matchesNextQuestionMode(
  question: DueQuestion,
  mode: NextQuestionMode,
): boolean {
  const hasReviewHistory = parseReviews(question.reviews).length > 0;

  return mode === "learn" ? !hasReviewHistory : true;
}

function resetQueueStateForUser(userId: string): void {
  state.userId = userId;
  state.initialized = false;
  state.initializing = null;
  state.queue = [];
  state.pendingEvaluations = 0;
  state.inFlightQuestionKeys = new Set();
  state.evaluations = [];
  state.latestByQuestionKey = {};
}

export function invalidateReviewQueue(): void {
  state.initialized = false;
  state.initializing = null;
  state.queue = [];
  logQueueFlushStatus("invalidated-review-queue");
  void broadcastQueueStatus();
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
    inFlightQuestions: state.inFlightQuestionKeys.size,
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
  questionId: string | null;
  deckId: string | null;
  question: string;
  answer: string;
  submittedAt: number;
}): EvaluationQueueItem {
  const id = `${input.submittedAt}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    traceId: input.traceId,
    questionId: input.questionId,
    deckId: input.deckId,
    question: input.question,
    answer: input.answer,
    status: "grading",
    phase: "queued",
    lastActivityAt: input.submittedAt,
    submittedAt: input.submittedAt,
    score: null,
    justification: null,
    answerSummary: null,
    correctAnswer: null,
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
  item.correctAnswer = result.correctAnswer;
  item.resolvedAt = Date.now();
  item.nextDue = nextDue;

  if (result.status === "graded") {
    state.latestByQuestionKey[questionKey(item)] = {
      score: result.score,
      justification: result.justification,
      answerSummary: result.answerSummary,
      correctAnswer: result.correctAnswer,
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
  item.lastActivityAt = Date.now();
  void broadcastQueueStatus();
}

function touchEvaluationActivity(
  evaluationId: string,
  phase: EvaluationPhase,
): boolean {
  const item = state.evaluations.find(
    (evaluation) => evaluation.id === evaluationId,
  );

  if (!item || item.status !== "grading") {
    return false;
  }

  const now = Date.now();

  if (item.phase !== phase) {
    item.phase = phase;
    item.lastActivityAt = now;
    void broadcastQueueStatus();
    return true;
  }

  if (now - item.lastActivityAt < 1_000) {
    return false;
  }

  item.lastActivityAt = now;
  void broadcastQueueStatus();
  return true;
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

function mergeEvaluationItems(
  memoryItems: EvaluationQueueItem[],
  persistedItems: EvaluationQueueItem[],
): EvaluationQueueItem[] {
  const byId = new Map<string, EvaluationQueueItem>();

  for (const item of memoryItems) {
    byId.set(item.id, item);
  }

  for (const item of persistedItems) {
    const existing = byId.get(item.id);

    if (!existing || item.status === "resolved" || existing.status !== "resolved") {
      byId.set(item.id, item);
    }
  }

  return [...byId.values()].sort((left, right) => {
    const leftTime = left.resolvedAt ?? left.submittedAt;
    const rightTime = right.resolvedAt ?? right.submittedAt;

    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
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
    query?: string;
    includeQuestionAttempts?: boolean;
  },
  now = Date.now(),
): Promise<{
  items: ReviewQueueItem[];
  total: number;
}> {
  const searchQuery = normalizeEmbeddingText(input.query ?? "");
  const excludeQuestionIds = Array.from(state.inFlightQuestionKeys).filter(
    (key) => !key.startsWith("question:"),
  );
  const queuedQuestionsPage = searchQuery
    ? await getQueuedQuestionsByEmbeddingProximityPage({
        userId,
        deckId: input.deckId,
        excludeQuestionIds,
        queryEmbedding: await embedQueueSearchQuery({
          query: searchQuery,
          userId,
          deckId: input.deckId ?? null,
        }),
        limit: input.limit,
        offset: input.offset,
        maxResults: QUEUE_SEARCH_TOP_K,
      })
    : await getQueuedQuestionsPage({
        userId,
        deckId: input.deckId,
        excludeQuestionIds,
        limit: input.limit,
        offset: input.offset,
        sortKey: input.sortKey,
      });
  const queuedQuestions = queuedQuestionsPage.items;
  const attemptsByQuestionId = input.includeQuestionAttempts === false
    ? new Map<string, QuestionAttempt[]>()
    : await getQuestionAttemptsByQuestionIds({
        userId,
        questionIds: queuedQuestions.map((item) => item.questionId),
      });
  const items = queuedQuestions.map((item) => {
    const latest = state.latestByQuestionKey[questionKey(item)];

    return toReviewQueueItem(item, {
      now,
      latest,
      attempts: attemptsByQuestionId.get(item.questionId) ?? [],
    });
  });

  return {
    total: queuedQuestionsPage.total,
    items: searchQuery
      ? items
      : items.sort((a, b) => {
        if (input.sortKey === "creation-date") {
          return b.createdAt - a.createdAt || a.question.localeCompare(b.question);
        }

        return (
          a.nextDue - b.nextDue ||
          a.createdAt - b.createdAt ||
          a.question.localeCompare(b.question)
        );
      }),
  };
}

async function embedQueueSearchQuery(input: {
  query: string;
  userId: string;
  deckId: string | null;
}): Promise<number[]> {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  }

  const { response, body } = await openRouterEmbeddings({
    apiKey,
    trace: {
      operation: "queue_search_embedding",
      userId: input.userId,
      deckId: input.deckId,
      question: input.query,
    },
    body: {
      model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input: [input.query],
      encoding_format: "float",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter embedding request failed (${response.status}).`);
  }

  const embedding = body.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length !== DEDUPE_EMBEDDING_DIMENSIONS) {
    throw new Error("OpenRouter returned an unexpected search embedding.");
  }

  return embedding.map((component, index) => {
    const value = Number(component);

    if (!Number.isFinite(value)) {
      throw new Error(`Search embedding contains a non-finite value at ${index}.`);
    }

    return value;
  });
}

function toReviewQueueItem(
  item: DueQuestion,
  input: {
    now: number;
    latest?: LatestEvaluation;
    attempts?: QuestionAttempt[];
  },
): ReviewQueueItem {
  const msUntilDue = item.nextDue - input.now;
  const reviewHistory = parseReviews(item.reviews);
  const lastReview = reviewHistory.at(-1);

  return {
    questionId: item.questionId,
    deckId: item.deckId,
    deckName: item.deckName,
    question: item.question,
    nextDue: item.nextDue,
    createdAt: item.createdAt,
    msUntilDue,
    status: msUntilDue <= 0 ? "now" : "scheduled",
    generatedFromQuestion: item.generatedFromQuestion,
    questionProvenance: item.questionProvenance,
    reviewHistory,
    lastScore: input.latest?.score ?? lastReview?.score ?? null,
    lastAnswer: item.lastAnswer,
    lastAnswerSummary: input.latest?.answerSummary ?? item.lastAnswerSummary,
    conciseAnswer: input.latest?.correctAnswer ?? item.conciseAnswer,
    referenceAnswer: item.referenceAnswer,
    lastJustification: input.latest?.justification ?? null,
    attempts: input.attempts ?? [],
  };
}

export async function loadReviewSessionQueue(input: {
  deckId?: string | null;
} = {}): Promise<{
  items: ReviewQueueItem[];
}> {
  const user = await getCurrentUser();
  const now = Date.now();
  const dueQuestions = (await getDueQuestions(now, { userId: user.id })).filter(
    (item) => !input.deckId || item.deckId === input.deckId,
  );

  return {
    items: dueQuestions.map((item) =>
      toReviewQueueItem(item, {
        now,
        latest: state.latestByQuestionKey[questionKey(item)],
      }),
    ),
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
    (question) => !state.inFlightQuestionKeys.has(questionKey(question)),
  );
  logQueueFlushStatus("refreshed-empty-queue");
}

function removeFromQueue(input: {
  questionId?: string | null;
  question: string;
}): DueQuestion | null {
  const targetKey = questionKey(input);
  const index = state.queue.findIndex((item) => questionKey(item) === targetKey);

  if (index === -1) {
    return null;
  }

  const [removed] = state.queue.splice(index, 1);
  return removed ?? null;
}

function restoreFailedQuestion(question: DueQuestion | null): void {
  if (!question) {
    return;
  }

  state.queue = [
    question,
    ...state.queue.filter((item) => questionKey(item) !== questionKey(question)),
  ];
  logQueueFlushStatus("restored-failed-evaluation-question");
}

function appendRetryQuestion(question: DueQuestion | null): void {
  if (!question) {
    return;
  }

  state.queue = [
    ...state.queue.filter((item) => questionKey(item) !== questionKey(question)),
    question,
  ];
  logQueueFlushStatus("appended-retry-question");
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
          restoreQuestion: false,
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
          restoreQuestion: true,
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
    updateEvaluationPhase(submission.evaluationId, phase);
    void updateAnswerEvaluationPhase({
      id: submission.evaluationId,
      phase,
    });
  };
  const markActivity = () => {
    resetWatchdog();
    touchEvaluationActivity(submission.evaluationId, currentPhase);
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
    clearWatchdog();
    phaseTimingsMs[currentPhase] =
      (phaseTimingsMs[currentPhase] ?? 0) + Date.now() - phaseStartedAt;

    if (options.restoreQuestion) {
      restoreFailedQuestion(submission.queuedQuestion);
    }

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

    resolveEvaluationItem(submission.evaluationId, result, nextDue);
    state.pendingEvaluations = Math.max(0, state.pendingEvaluations - 1);
    state.inFlightQuestionKeys.delete(questionKey(submission));
    logQueueFlushStatus(options.logAction);
    void broadcastQueueStatus();
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
      deckId: submission.deckId,
      traceId: submission.traceId,
      onActivity: markActivity,
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
      userId: submission.userId ?? undefined,
    });

    if (isFinished) {
      return;
    }

    if (persisted) {
      const evaluationNextDue = result.score < 10 ? null : persisted.nextDue;

      await persistEvaluationResolution({
        evaluationId: submission.evaluationId,
        result,
        nextDue: evaluationNextDue,
        resolvedAt,
      });
      savedEvaluationNextDue = evaluationNextDue;

      if (result.score < 10) {
        appendRetryQuestion(persisted);
      }
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
  questionId: string | null;
  question: string | null;
  deckId: string | null;
  deckName: string | null;
  queueRemaining: number;
}>;
export async function peekNextQuestion(input: NextQuestionInput): Promise<{
  questionId: string | null;
  question: string | null;
  deckId: string | null;
  deckName: string | null;
  queueRemaining: number;
}>;
export async function peekNextQuestion(input: NextQuestionInput = {}): Promise<{
  questionId: string | null;
  question: string | null;
  deckId: string | null;
  deckName: string | null;
  queueRemaining: number;
}> {
  const user = await initializeQueue();
  await refreshIfEmpty(user.id);
  const mode = input.mode ?? "review";
  const deckId = input.deckId?.trim() || null;
  const excludedQuestionKey = input.excludeQuestionId?.trim() || null;
  const excludedQuestion = input.excludeQuestion?.trim() || null;
  const matchingQueue = state.queue.filter(
    (item) =>
      matchesNextQuestionMode(item, mode) &&
      (!deckId || item.deckId === deckId) &&
      !state.inFlightQuestionKeys.has(questionKey(item)),
  );
  const availableQueue = matchingQueue.filter(
    (item) =>
      item.questionId !== excludedQuestionKey &&
      item.question !== excludedQuestion,
  );
  const nextQuestion = availableQueue[0] ?? null;

  return {
    questionId: nextQuestion?.questionId ?? null,
    question: nextQuestion?.question ?? null,
    deckId: nextQuestion?.deckId ?? null,
    deckName: nextQuestion?.deckName ?? null,
    queueRemaining: availableQueue.length,
  };
}

export async function skipQuestion(input: {
  mode?: NextQuestionMode;
  questionId?: string | null;
  question: string;
}): Promise<{
  questionId: string | null;
  question: string | null;
  deckId: string | null;
  deckName: string | null;
  queueRemaining: number;
}> {
  const user = await initializeQueue();
  await refreshIfEmpty(user.id);

  const skipped = removeFromQueue(input);

  if (skipped) {
    state.queue.push(skipped);
    logQueueFlushStatus("skipped-question");
    void broadcastQueueStatus();
  }

  return peekNextQuestion({ mode: input.mode });
}

export async function submitAnswer(input: {
  questionId: string;
  question: string;
  answer: string;
}): Promise<{ evaluationId: string; traceId: string }> {
  const user = await getCurrentUser();
  const requestedQuestionId = input.questionId.trim();

  if (!requestedQuestionId) {
    throw new Error("questionId is required.");
  }

  const snapshot = await getQuestionSnapshotById(requestedQuestionId, {
    userId: user.id,
  });

  if (!snapshot) {
    throw new Error("Question not found.");
  }

  const snapshotDeck = (await listDecks({ userId: user.id })).find(
    (deck) => deck.id === snapshot.deckId,
  );

  if (!snapshotDeck?.inReviewRotation) {
    throw new Error("Question is not in review.");
  }

  const normalizedInputQuestion = input.question.trim().replace(/\s+/g, " ");
  const normalizedSnapshotQuestion = snapshot.question.trim().replace(/\s+/g, " ");

  if (normalizedInputQuestion !== normalizedSnapshotQuestion) {
    throw new Error("Question mismatch.");
  }

  const submittedAt = Date.now();
  const traceId = crypto.randomUUID();
  const questionId = snapshot.questionId;
  const deckId = snapshot.deckId;
  const evaluation = createEvaluationItem({
    traceId,
    questionId,
    deckId,
    question: snapshot.question,
    answer: input.answer,
    submittedAt,
  });

  await recordPendingLlmTrace({
    traceId,
    operation: "evaluate_answer",
    model: "pending-evaluation",
    question: snapshot.question,
    requestBody: {
      evaluationId: evaluation.id,
      questionId,
      deckId,
      submittedAt,
    },
  });
  await createAnswerEvaluationRecord({
    id: evaluation.id,
    traceId,
    userId: snapshot.userId,
    deckId,
    question: snapshot.question,
    answer: input.answer,
    submittedAt,
  });
  state.evaluations = [...state.evaluations, evaluation].slice(-50);
  const queuedQuestion = removeFromQueue(snapshot);
  state.inFlightQuestionKeys.add(questionKey(snapshot));
  state.pendingEvaluations += 1;
  logQueueFlushStatus("submitted-answer");
  void broadcastQueueStatus();

  const submission = {
    evaluationId: evaluation.id,
    traceId,
    questionId,
    question: snapshot.question,
    queuedQuestion: queuedQuestion ?? snapshot,
    userId: snapshot.userId,
    deckId,
    answer: input.answer,
    expectedAnswer: snapshot.conciseAnswer || null,
    submittedAt,
    previousReviews: snapshot.reviews,
  } satisfies Submission;

  after(() => processEvaluation(submission));

  return {
    evaluationId: evaluation.id,
    traceId,
  };
}

export async function addQuestionsToDeck(input: {
  questions: Array<string | QuestionInput>;
  deckId?: string;
  sourceQuestion?: string | null;
}): Promise<{ added: number; rejected: number }> {
  const user = await getCurrentUser();
  const deckId = await resolveOwnedDeckId({
    userId: user.id,
    deckId: input.deckId,
  });

  const gateResult = await gateNovelQuestions(input.questions, {
    operation: "add_questions_gate",
    userId: user.id,
    deckId,
  });
  const provenanceByQuestion = new Map(
    input.questions
      .filter((question): question is QuestionInput => typeof question !== "string")
      .map((question) => [
        question.question.trim().replace(/\s+/g, " ").toLowerCase(),
        question.questionProvenance?.trim().replace(/\s+/g, " ") ?? "",
      ]),
  );

  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
      questionProvenance:
        provenanceByQuestion.get(candidate.question.toLowerCase()) ?? "",
    })),
    sourceQuestion: input.sourceQuestion ?? null,
    now: Date.now(),
    deckId,
    userId: user.id,
  });

  await upsertQuestionEmbeddings({
    embeddings: gateResult.accepted
      .filter((candidate) => candidate.embedding.length > 0)
      .map((candidate) => ({
        question: candidate.question,
        embeddingModel: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
        embeddingKind: DEDUPE_EMBEDDING_KIND,
        sourceVersion: DEDUPE_SOURCE_VERSION,
        sourceHash: candidate.sourceHash,
        embedding: candidate.embedding,
      })),
    deckId,
    userId: user.id,
  });

  void broadcastQueueStatus();

  return {
    added: addedQuestions.length,
    rejected: gateResult.rejected.length,
  };
}

function emptyDeckEmbeddingPlot(): DeckEmbeddingPlot {
  return {
    model: null,
    totalQuestions: 0,
    embeddedQuestions: 0,
    points: [],
  };
}

export async function deckEmbeddingPlotStatus(input: {
  deckId?: string;
  limit?: number;
  offset?: number;
  sortKey?: QueuedQuestionsSortKey;
} = {}): Promise<DeckEmbeddingPlot> {
  const user = await getCurrentUser();
  const limit = Math.min(2_000, Math.max(0, Math.floor(input.limit ?? 48)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const sortKey = input.sortKey ?? "review-date";
  const reviewQueuePage = await getQueuedQuestionsPage({
    userId: user.id,
    deckId: input.deckId,
    excludeQuestionIds: Array.from(state.inFlightQuestionKeys).filter(
      (key) => !key.startsWith("question:"),
    ),
    limit,
    offset,
    sortKey,
  });

  return getDeckEmbeddingPlot({
    userId: user.id,
    deckId: input.deckId,
    questions: reviewQueuePage.items.map((item) => item.question),
    totalQuestions: reviewQueuePage.total,
  });
}

export async function queueStatus(input: QueueStatusInput = {}): Promise<QueueStatusSnapshot> {
  const user = await getCurrentUser();
  const now = Date.now();
  const query = normalizeEmbeddingText(input.query ?? "");
  const limitCap = query ? QUEUE_SEARCH_TOP_K : 2_000;
  const limit = Math.min(limitCap, Math.max(0, Math.floor(input.limit ?? 24)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const sortKey = input.sortKey ?? "review-date";
  const includeReviewQueue = input.includeReviewQueue ?? true;
  const includeRecentAttempts = input.includeRecentAttempts ?? true;
  const reviewQueuePage = includeReviewQueue
    ? await getReviewQueueItems(user.id, {
        deckId: input.deckId,
        limit,
        offset,
        sortKey,
        query,
        includeQuestionAttempts: input.includeQuestionAttempts,
      })
    : { items: [], total: 0 };
  const recentAttempts = includeRecentAttempts
    ? await getRecentQuestionAttempts({
        userId: user.id,
        deckScope: input.deckId ? undefined : "rotation",
        deckId: input.deckId,
        limit: 24,
      })
    : [];
  const deckEmbeddingPlot = input.includeDeckEmbeddingPlot
    ? await getDeckEmbeddingPlot({
        userId: user.id,
        deckId: input.deckId,
        questions: reviewQueuePage.items.map((item) => item.question),
        totalQuestions: reviewQueuePage.total,
      })
    : emptyDeckEmbeddingPlot();
  const persistedEvaluations = await getVisibleAnswerEvaluations({
    userId: user.id,
    deckId: input.deckId,
    activeSince: now - ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS,
    resolvedSince: now - RESOLVED_JUDGING_VISIBLE_MS,
    limit: 50,
  });
  const dueQuestions = await getDueQuestions(now, { userId: user.id });

  return {
    queueRemaining: dueQuestions.length,
    pendingEvaluations: state.pendingEvaluations,
    evaluations: mergeEvaluationItems(getVisibleEvaluations(now), persistedEvaluations),
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
