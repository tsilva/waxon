import { after } from "next/server";
import {
  applyEvaluationToPostgres,
  countDueQuestions,
  createAnswerEvaluationRecord,
  flagQuestionForReview,
  getDueQuestions,
  getNextScheduledQuestionDue,
  getVisibleAnswerEvaluations,
  getQuestionAttemptsByQuestionIds,
  getQueuedQuestionsPage,
  getQueuedQuestionsByEmbeddingProximityPage,
  getQuestionSnapshotById,
  getRecentQuestionAttempts,
  resolveAnswerEvaluationRecord,
  readQuestionEmbeddingProjections,
  updateAnswerEvaluationPhase,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
  type DueQuestion,
  type QuestionInput,
  type QueuedQuestionsSortKey,
} from "./postgresStore";
import { questionHasActiveConceptTag } from "./conceptTags";
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
import { questionSlug } from "./questionSlug";
import type {
  KnowledgeEmbeddingPlot,
  KnowledgeEmbeddingPlotPoint,
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
  QueueStatusSnapshot,
  ReviewQueueItem,
} from "./reviewTypes";
import type { NovelQuestionGateResult } from "./semanticDedupe";

export const RESOLVED_JUDGING_VISIBLE_MS = 5 * 60_000;
const EVALUATION_PROCESSING_TIMEOUT_MS = EVALUATION_TIMEOUT_MS;
const ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS = 5 * 60_000;
const QUEUE_SEARCH_TOP_K = 200;
const REVIEW_SESSION_QUEUE_LIMIT = 200;
const KNOWLEDGE_EMBEDDING_PLOT_LIMIT = 500;

type Submission = {
  state: QueueState;
  evaluationId: string;
  traceId: string;
  questionId: string | null;
  question: string;
  queuedQuestion: DueQuestion | null;
  userId: string | null;
  answer: string;
  expectedAnswer: string | null;
  submittedAt: number;
  previousReviews: string;
};

type QueueStatusBroadcastMode = "full" | "evaluations";
type QueueStatusSubscriber = (mode: QueueStatusBroadcastMode) => void;

type QueueStatusInput = {
  limit?: number;
  offset?: number;
  sortKey?: QueuedQuestionsSortKey;
  query?: string;
  includeReviewQueue?: boolean;
  includeQuestionAttempts?: boolean;
  includeRecentAttempts?: boolean;
  recentAttemptsLimit?: number;
  includeKnowledgeEmbeddingPlot?: boolean;
  includeQueueCounts?: boolean;
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
  waxonQueueStates?: Map<string, QueueState>;
};

function createQueueState(userId: string | null): QueueState {
  return {
    userId,
    initialized: false,
    initializing: null,
    queue: [],
    pendingEvaluations: 0,
    inFlightQuestionKeys: new Set<string>(),
    evaluations: [],
    latestByQuestionKey: {},
    subscribers: new Set<QueueStatusSubscriber>(),
  };
}

const queueStates =
  globalForQueue.waxonQueueStates ?? new Map<string, QueueState>();

globalForQueue.waxonQueueStates = queueStates;

function getQueueStateForUser(userId: string): QueueState {
  const existing = queueStates.get(userId);

  if (existing) {
    return existing;
  }

  const state = createQueueState(userId);

  queueStates.set(userId, state);
  return state;
}

type QueueContext = {
  user: AuthenticatedUser;
  state: QueueState;
};

function questionKey(input: {
  questionId?: string | null;
  question: string;
}): string {
  return input.questionId ?? `question:${input.question}`;
}

export function invalidateReviewQueue(userId?: string): void {
  const states = userId
    ? [getQueueStateForUser(userId)]
    : Array.from(queueStates.values());

  for (const state of states) {
    state.initialized = false;
    state.initializing = null;
    state.queue = [];
    logQueueFlushStatus(state, "invalidated-review-queue");
    void broadcastQueueStatus(state, "full");
  }
}

async function ensureQueueContext(): Promise<QueueContext> {
  const user = await getCurrentUser();
  const state = getQueueStateForUser(user.id);

  state.userId = user.id;

  return { user, state };
}

function logQueueFlushStatus(state: QueueState, action: string): void {
  console.info("[waxon] queue flush status", {
    action,
    userId: state.userId,
    queueRemaining: state.queue.length,
    pendingEvaluations: state.pendingEvaluations,
    inFlightQuestions: state.inFlightQuestionKeys.size,
    evaluationsTracked: state.evaluations.length,
    initialized: state.initialized,
  });
}

async function broadcastQueueStatus(
  state: QueueState,
  mode: QueueStatusBroadcastMode = "full",
): Promise<void> {
  if (state.subscribers.size === 0) {
    return;
  }

  for (const subscriber of state.subscribers) {
    subscriber(mode);
  }
}

export function subscribeQueueStatus(
  userId: string,
  subscriber: QueueStatusSubscriber,
): () => void {
  const state = getQueueStateForUser(userId);

  state.subscribers.add(subscriber);

  return () => {
    state.subscribers.delete(subscriber);
  };
}

function createEvaluationItem(input: {
  traceId: string;
  questionId: string | null;
  question: string;
  answer: string;
  submittedAt: number;
}): EvaluationQueueItem {
  const id = `${input.submittedAt}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    traceId: input.traceId,
    questionId: input.questionId,
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
    cost: null,
  };
}

function resolveEvaluationItem(
  state: QueueState,
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
  state: QueueState,
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
  void broadcastQueueStatus(state, "evaluations");
}

function touchEvaluationActivity(
  state: QueueState,
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
    void broadcastQueueStatus(state, "evaluations");
    return true;
  }

  if (now - item.lastActivityAt < 1_000) {
    return false;
  }

  item.lastActivityAt = now;
  void broadcastQueueStatus(state, "evaluations");
  return true;
}

function getVisibleEvaluations(
  state: QueueState,
  now = Date.now(),
): EvaluationQueueItem[] {
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

function normalizeProjectionValue(value: number, min: number, max: number): number {
  if (max - min <= Number.EPSILON) {
    return 0.5;
  }

  return (value - min) / (max - min);
}

function normalizeProjectionPoints(
  rows: Array<{
    question: string;
    lastScore: number | null;
    projectionX: number;
    projectionY: number;
  }>,
): KnowledgeEmbeddingPlotPoint[] {
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

  const xValues = rows.map((point) => point.projectionX);
  const yValues = rows.map((point) => point.projectionY);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return rows.map((point) => ({
    question: point.question,
    lastScore: point.lastScore,
    x: normalizeProjectionValue(point.projectionX, minX, maxX),
    y: normalizeProjectionValue(point.projectionY, minY, maxY),
  }));
}

async function getKnowledgeEmbeddingPlot(input: {
  limit?: number;
  offset?: number;
  questions?: string[];
  totalQuestions?: number;
  userId: string;
}): Promise<KnowledgeEmbeddingPlot> {
  const questions = await readQuestionEmbeddingProjections({
    userId: input.userId,
    questions: input.questions,
    embeddingModel: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    embeddingKind: DEDUPE_EMBEDDING_KIND,
    currentOnly: true,
    limit: input.questions ? undefined : input.limit,
    offset: input.questions ? undefined : input.offset,
  });
  const totalQuestions = input.totalQuestions ?? questions.length;
  const modelCounts = new Map<string, number>();
  const projectedRows = questions.filter(
    (question) =>
      question.embeddingModel &&
      question.embeddingKind === DEDUPE_EMBEDDING_KIND &&
      question.isCurrent &&
      question.projectionX !== null &&
      question.projectionY !== null,
  );

  for (const embedding of projectedRows) {
    const embeddingModel = embedding.embeddingModel;

    if (!embeddingModel) {
      continue;
    }

    modelCounts.set(
      embeddingModel,
      (modelCounts.get(embeddingModel) ?? 0) + 1,
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

  const selectedEmbeddings = projectedRows
    .map((question) => {
      return question.embeddingModel === model &&
        question.projectionX !== null &&
        question.projectionY !== null
        ? {
            question: question.question,
            lastScore: parseReviews(question.reviews).at(-1)?.score ?? null,
            projectionX: question.projectionX,
            projectionY: question.projectionY,
          }
        : null;
    })
    .filter(
      (item): item is {
        question: string;
        lastScore: number | null;
        projectionX: number;
        projectionY: number;
      } =>
        item !== null &&
        Number.isFinite(item.projectionX) &&
        Number.isFinite(item.projectionY),
    );

  return {
    model,
    totalQuestions,
    embeddedQuestions: selectedEmbeddings.length,
    points: normalizeProjectionPoints(selectedEmbeddings),
  };
}

async function getReviewQueueItems(
  userId: string,
  state: QueueState,
  input: {
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
        excludeQuestionIds,
        queryEmbedding: await embedQueueSearchQuery({
          query: searchQuery,
          userId,
        }),
        limit: input.limit,
        offset: input.offset,
        maxResults: QUEUE_SEARCH_TOP_K,
      })
    : await getQueuedQuestionsPage({
        userId,
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
    lastScore: input.latest?.score ?? latestAttempt?.score ?? lastReview?.score ?? null,
    lastAnswer: item.lastAnswer ?? latestAttempt?.rawAnswer ?? null,
    lastAnswerSummary:
      input.latest?.answerSummary ??
      item.lastAnswerSummary ??
      latestAttempt?.answerSummary ??
      null,
    conciseAnswer:
      input.latest?.correctAnswer ??
      item.conciseAnswer ??
      latestAttempt?.correctAnswer ??
      null,
    referenceAnswer: item.referenceAnswer,
    lastJustification: input.latest?.justification ?? latestAttempt?.justification ?? null,
    attempts: input.attempts ?? [],
    conceptSlugs: item.conceptSlugs,
  };
}

export async function loadReviewSessionQueue(input: {
  excludeQuestionIds?: string[];
  limit?: number;
  offset?: number;
} = {}): Promise<{
  items: ReviewQueueItem[];
}> {
  const user = await getCurrentUser();
  const state = getQueueStateForUser(user.id);
  const now = Date.now();
  const limit = Math.min(
    REVIEW_SESSION_QUEUE_LIMIT,
    Math.max(0, Math.floor(input.limit ?? REVIEW_SESSION_QUEUE_LIMIT)),
  );
  const dueQuestions = await getDueQuestions(now, {
    userId: user.id,
    excludeQuestionIds: input.excludeQuestionIds,
    limit,
    offset: input.offset,
  });

  return {
    items: dueQuestions.map((item) =>
      toReviewQueueItem(item, {
        now,
        latest: state.latestByQuestionKey[questionKey(item)],
      }),
    ),
  };
}

async function initializeQueue(): Promise<QueueContext> {
  const { user, state } = await ensureQueueContext();

  if (state.initialized) {
    return { user, state };
  }

  if (!state.initializing) {
    state.initializing = getDueQuestions(Date.now(), {
      userId: user.id,
      limit: REVIEW_SESSION_QUEUE_LIMIT,
    }).then((dueQuestions) => {
      state.queue = dueQuestions;
      state.initialized = true;
      state.initializing = null;
      logQueueFlushStatus(state, "initialized");
    });
  }

  await state.initializing;
  return { user, state };
}

async function refreshIfEmpty(state: QueueState, userId: string): Promise<void> {
  if (state.queue.length > 0) {
    return;
  }

  const dueQuestions = await getDueQuestions(Date.now(), {
    userId,
    excludeQuestionIds: Array.from(state.inFlightQuestionKeys).filter(
      (key) => !key.startsWith("question:"),
    ),
    limit: REVIEW_SESSION_QUEUE_LIMIT,
  });
  state.queue = dueQuestions.filter(
    (question) => !state.inFlightQuestionKeys.has(questionKey(question)),
  );
  logQueueFlushStatus(state, "refreshed-empty-queue");
}

function removeFromQueue(state: QueueState, input: {
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

function restoreFailedQuestion(
  state: QueueState,
  question: DueQuestion | null,
): void {
  if (!question) {
    return;
  }

  state.queue = [
    question,
    ...state.queue.filter((item) => questionKey(item) !== questionKey(question)),
  ];
  logQueueFlushStatus(state, "restored-failed-evaluation-question");
}

function prependRetryQuestion(
  state: QueueState,
  question: DueQuestion | null,
): void {
  if (!question || question.flaggedAt !== null) {
    return;
  }

  state.queue = [
    question,
    ...state.queue.filter((item) => questionKey(item) !== questionKey(question)),
  ];
  logQueueFlushStatus(state, "prepended-retry-question");
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
  const state = submission.state;
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
    updateEvaluationPhase(state, submission.evaluationId, phase);
    void updateAnswerEvaluationPhase({
      id: submission.evaluationId,
      phase,
    });
  };
  const markActivity = () => {
    resetWatchdog();
    touchEvaluationActivity(state, submission.evaluationId, currentPhase);
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
      restoreFailedQuestion(state, submission.queuedQuestion);
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

    resolveEvaluationItem(state, submission.evaluationId, result, nextDue);
    state.pendingEvaluations = Math.max(0, state.pendingEvaluations - 1);
    state.inFlightQuestionKeys.delete(questionKey(submission));
    logQueueFlushStatus(state, options.logAction);
    void broadcastQueueStatus(state);
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
      const evaluationNextDue = persisted.nextDue;

      await persistEvaluationResolution({
        evaluationId: submission.evaluationId,
        result,
        nextDue: evaluationNextDue,
        resolvedAt,
      });
      savedEvaluationNextDue = evaluationNextDue;

      if (evaluationNextDue <= resolvedAt) {
        prependRetryQuestion(state, persisted);
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
  queueRemaining: number;
}> {
  const { user, state } = await initializeQueue();
  await refreshIfEmpty(state, user.id);
  const availableQueue = state.queue.filter(
    (item) => !state.inFlightQuestionKeys.has(questionKey(item)),
  );
  const nextQuestion = availableQueue[0] ?? null;

  return {
    questionId: nextQuestion?.questionId ?? null,
    question: nextQuestion?.question ?? null,
    queueRemaining: await countDueQuestions(Date.now(), {
      userId: user.id,
    }),
  };
}

export async function flagQuestion(input: {
  questionId: string;
  question: string;
}): Promise<{
  questionId: string | null;
  question: string | null;
  queueRemaining: number;
}> {
  const { user, state } = await initializeQueue();
  await refreshIfEmpty(state, user.id);

  const flagged = await flagQuestionForReview({
    userId: user.id,
    questionId: input.questionId,
    question: input.question,
  });

  if (flagged) {
    state.queue = state.queue.filter(
      (item) => questionKey(item) !== questionKey(flagged),
    );
    state.inFlightQuestionKeys.delete(questionKey(flagged));
    logQueueFlushStatus(state, "flagged-question");
    void broadcastQueueStatus(state);
  }

  return peekNextQuestion();
}

export async function submitAnswer(input: {
  questionId: string;
  question: string;
  answer: string;
}): Promise<{ evaluationId: string; traceId: string }> {
  const user = await getCurrentUser();
  const state = getQueueStateForUser(user.id);
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

  if (
    !(await questionHasActiveConceptTag({
      userId: user.id,
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
  const evaluation = createEvaluationItem({
    traceId,
    questionId,
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
      submittedAt,
    },
  });
  await createAnswerEvaluationRecord({
    id: evaluation.id,
    traceId,
    userId: snapshot.userId,
    question: snapshot.question,
    answer: input.answer,
    submittedAt,
  });
  state.evaluations = [...state.evaluations, evaluation].slice(-50);
  const queuedQuestion = removeFromQueue(state, snapshot);
  state.inFlightQuestionKeys.add(questionKey(snapshot));
  state.pendingEvaluations += 1;
  logQueueFlushStatus(state, "submitted-answer");
  void broadcastQueueStatus(state);

  const submission = {
    state,
    evaluationId: evaluation.id,
    traceId,
    questionId,
    question: snapshot.question,
    queuedQuestion: queuedQuestion ?? snapshot,
    userId: snapshot.userId,
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

function acceptQuestionsWithoutNoveltyGate(
  input: Array<string | QuestionInput>,
): NovelQuestionGateResult {
  const seen = new Set<string>();
  const accepted: NovelQuestionGateResult["accepted"] = [];

  for (const item of input) {
    const question = typeof item === "string" ? item : item.question;
    const normalizedQuestion = question.trim().replace(/\s+/g, " ");
    const slug = questionSlug(normalizedQuestion);

    if (!normalizedQuestion || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    accepted.push({
      question: normalizedQuestion,
      conciseAnswer:
        typeof item === "string"
          ? ""
          : (item.conciseAnswer ?? "").trim().replace(/\s+/g, " "),
      embedding: [],
      sourceHash: "",
    });
  }

  return {
    accepted,
    rejected: [],
  };
}

export async function addQuestionsToKnowledgeBase(input: {
  questions: Array<string | QuestionInput>;
  sourceQuestion?: string | null;
}): Promise<{ added: number; rejected: number }> {
  const user = await getCurrentUser();
  const { total: userCardCount } = await getQueuedQuestionsPage({
    userId: user.id,
    limit: 0,
    offset: 0,
    sortKey: "creation-date",
  });
  const gateResult =
    userCardCount === 0
      ? acceptQuestionsWithoutNoveltyGate(input.questions)
      : await gateNovelQuestions(input.questions, {
          operation: "add_questions_gate",
          userId: user.id,
        });
  const provenanceByQuestion = new Map(
    input.questions
      .filter((question): question is QuestionInput => typeof question !== "string")
      .map((question) => [
        question.question.trim().replace(/\s+/g, " ").toLowerCase(),
        question.questionProvenance?.trim().replace(/\s+/g, " ") ?? "",
      ]),
  );
  const proposedSlugsByQuestion = new Map(
    input.questions
      .filter((question): question is QuestionInput => typeof question !== "string")
      .map((question) => [
        question.question.trim().replace(/\s+/g, " ").toLowerCase(),
        question.proposedConceptSlugs ?? [],
      ]),
  );
  const sourceTextByQuestion = new Map(
    input.questions
      .filter((question): question is QuestionInput => typeof question !== "string")
      .map((question) => [
        question.question.trim().replace(/\s+/g, " ").toLowerCase(),
        question.sourceText ?? "",
      ]),
  );

  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
      questionProvenance:
        provenanceByQuestion.get(candidate.question.toLowerCase()) ?? "",
      proposedConceptSlugs:
        proposedSlugsByQuestion.get(candidate.question.toLowerCase()) ?? [],
      sourceText: sourceTextByQuestion.get(candidate.question.toLowerCase()) ?? "",
    })),
    sourceQuestion: input.sourceQuestion ?? null,
    now: Date.now(),
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
    userId: user.id,
  });

  void broadcastQueueStatus(getQueueStateForUser(user.id));

  return {
    added: addedQuestions.length,
    rejected: gateResult.rejected.length,
  };
}

function emptyKnowledgeEmbeddingPlot(): KnowledgeEmbeddingPlot {
  return {
    model: null,
    totalQuestions: 0,
    embeddedQuestions: 0,
    points: [],
  };
}

export async function knowledgeEmbeddingPlotStatus(input: {
  limit?: number;
  offset?: number;
  sortKey?: QueuedQuestionsSortKey;
} = {}): Promise<KnowledgeEmbeddingPlot> {
  const user = await getCurrentUser();
  const limit = Math.min(
    KNOWLEDGE_EMBEDDING_PLOT_LIMIT,
    Math.max(0, Math.floor(input.limit ?? KNOWLEDGE_EMBEDDING_PLOT_LIMIT)),
  );

  return getKnowledgeEmbeddingPlot({
    userId: user.id,
    limit,
    offset: input.offset,
  });
}

export async function queueStatusForUser(
  userId: string,
  input: QueueStatusInput = {},
): Promise<QueueStatusSnapshot> {
  const state = getQueueStateForUser(userId);
  const now = Date.now();
  const query = normalizeEmbeddingText(input.query ?? "");
  const limitCap = query ? QUEUE_SEARCH_TOP_K : 2_000;
  const limit = Math.min(limitCap, Math.max(0, Math.floor(input.limit ?? 24)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const sortKey = input.sortKey ?? "review-date";
  const includeReviewQueue = input.includeReviewQueue ?? true;
  const includeRecentAttempts = input.includeRecentAttempts ?? true;
  const includeQueueCounts = input.includeQueueCounts ?? true;
  const excludeQuestionIds = Array.from(state.inFlightQuestionKeys).filter(
    (key) => !key.startsWith("question:"),
  );
  const emptyReviewQueuePage = { items: [], total: 0 };
  const reviewQueuePagePromise = includeReviewQueue
    ? getReviewQueueItems(userId, state, {
        limit,
        offset,
        sortKey,
        query,
        includeQuestionAttempts: input.includeQuestionAttempts,
      })
    : Promise.resolve(emptyReviewQueuePage);
  const recentAttemptsPromise = includeRecentAttempts
    ? getRecentQuestionAttempts({
        userId,
        limit: Math.max(0, Math.floor(input.recentAttemptsLimit ?? 24)),
      })
    : Promise.resolve([]);
  const persistedEvaluationsPromise = getVisibleAnswerEvaluations({
    userId,
    activeSince: now - ACTIVE_PERSISTED_EVALUATION_VISIBLE_MS,
    resolvedSince: now - RESOLVED_JUDGING_VISIBLE_MS,
    limit: 50,
  });
  const queueRemainingPromise = includeQueueCounts
    ? countDueQuestions(now, {
        userId,
      })
    : Promise.resolve(null);
  const nextScheduledDuePromise = includeQueueCounts
    ? getNextScheduledQuestionDue(now, {
        userId,
        excludeQuestionIds,
      })
    : Promise.resolve(null);
  const knowledgeEmbeddingPlotPromise =
    input.includeKnowledgeEmbeddingPlot
      ? getKnowledgeEmbeddingPlot({
          userId,
        })
      : Promise.resolve(emptyKnowledgeEmbeddingPlot());
  const [
    reviewQueuePage,
    recentAttempts,
    persistedEvaluations,
    queueRemaining,
    nextScheduledDueFromDb,
    knowledgeEmbeddingPlot,
  ] = await Promise.all([
    reviewQueuePagePromise,
    recentAttemptsPromise,
    persistedEvaluationsPromise,
    queueRemainingPromise,
    nextScheduledDuePromise,
    knowledgeEmbeddingPlotPromise,
  ]);
  const nextScheduledDue =
    queueRemaining === null
      ? null
      : (reviewQueuePage.items.find((item) => item.nextDue > now)?.nextDue ??
        nextScheduledDueFromDb);

  return {
    queueRemaining: queueRemaining ?? 0,
    nextScheduledDue,
    pendingEvaluations: state.pendingEvaluations,
    evaluations: mergeEvaluationItems(
      getVisibleEvaluations(state, now),
      persistedEvaluations,
    ),
    recentAttempts,
    reviewQueue: reviewQueuePage.items,
    reviewQueueTotal: reviewQueuePage.total,
    reviewQueueOffset: offset,
    reviewQueueLimit: limit,
    reviewQueueHasMore:
      offset + reviewQueuePage.items.length < reviewQueuePage.total,
    knowledgeEmbeddingPlot,
  };
}

export async function queueStatus(
  input: QueueStatusInput = {},
): Promise<QueueStatusSnapshot> {
  const user = await getCurrentUser();

  return queueStatusForUser(user.id, input);
}
