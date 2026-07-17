import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/app/db/client";
import {
  answerEvaluations,
  llmTraceInteractions,
  questionAttempts,
  questionEmbeddings,
  questions,
} from "@/app/db/schema";
import {
  getCurrentUser,
  type AuthenticatedUser,
} from "./auth";
import { scheduleNextReview, type ReviewEntry } from "./scheduler";
import { questionSlug } from "./questionSlug";
import type { NormalizedQuestionDraft } from "./questionDraft";
import {
  projectEmbeddingForPlot,
} from "./embeddingSource";
import type {
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
} from "./reviewTypes";
import {
  activeConceptEligibilityClause,
  assignConceptSlugsForQuestions,
  getQuestionConceptSlugs,
} from "./conceptTags";

export type QuestionRow = {
  question_id: string;
  user_id: string;
  question: string;
  review_history: ReviewEntry[];
  next_due: number;
  generated_from_question: string | null;
  question_provenance: string;
  last_answer: string;
  last_answer_summary: string;
  concise_answer: string;
  flagged_at: number | null;
  created_at: number;
  concept_slugs?: string[];
};

export type DueQuestion = {
  questionId: string;
  userId: string;
  question: string;
  reviewHistory: ReviewEntry[];
  nextDue: number;
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  flaggedAt: number | null;
  createdAt: number;
  conceptSlugs: string[];
};

export type QuestionEmbedding = {
  question: string;
  embeddingModel: string;
  embeddingKind: string;
  sourceVersion: number;
  sourceHash: string;
  isCurrent: boolean;
  embedding: number[];
  projectionX: number | null;
  projectionY: number | null;
  createdAt: number;
  updatedAt: number;
};

export type QuestionEmbeddingProjection = {
  question: string;
  lastScore: number | null;
  embeddingModel: string | null;
  embeddingKind: string | null;
  isCurrent: boolean | null;
  projectionX: number | null;
  projectionY: number | null;
};

export type PersistedEvaluation = DueQuestion | null;

const EVALUATION_PHASES = new Set<EvaluationPhase>([
  "queued",
  "evaluating-answer",
  "saving-evaluation",
  "finalizing",
]);

type UserContextInput = {
  user?: AuthenticatedUser;
  userId?: string;
};

export type DueQuestionsInput = UserContextInput & {
  excludeQuestionIds?: string[];
  limit?: number;
  offset?: number;
};

type UserContext = {
  userId: string;
};

async function resolveUserContext(input: UserContextInput = {}): Promise<UserContext> {
  const user = input.user ?? (input.userId ? null : await getCurrentUser());
  const userId = input.userId ?? user?.id;

  if (!userId) {
    throw new Error("User id is required.");
  }

  return { userId };
}

function toDueQuestion(row: QuestionRow): DueQuestion {
  return {
    questionId: row.question_id,
    userId: row.user_id,
    question: row.question,
    reviewHistory: normalizeReviewHistory(row.review_history),
    nextDue: row.next_due,
    generatedFromQuestion: row.generated_from_question || null,
    questionProvenance: row.question_provenance || null,
    lastAnswer: row.last_answer || null,
    lastAnswerSummary: row.last_answer_summary || null,
    conciseAnswer: row.concise_answer || null,
    flaggedAt: row.flagged_at,
    createdAt: row.created_at,
    conceptSlugs: row.concept_slugs ?? [],
  };
}

function normalizeReviewHistory(value: unknown): ReviewEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const ts = Number(record.ts);
    const score = Number(record.score);

    return Number.isFinite(ts) && ts > 0 && Number.isFinite(score) && score >= 0 && score <= 10
      ? [{ ts, score }]
      : [];
  });
}

const reviewHistorySql = sql<ReviewEntry[]>`COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object('ts', recent.resolved_at, 'score', recent.score)
    ORDER BY recent.resolved_at, recent.id
  )
  FROM (
    SELECT attempt.id, attempt.resolved_at, attempt.score
    FROM question_attempts attempt
    WHERE attempt.question_id = "questions"."id"
    ORDER BY attempt.resolved_at DESC, attempt.id DESC
    LIMIT 10
  ) recent
), '[]'::jsonb)`;

const questionIdentitySelection = {
  question_id: questions.id,
  user_id: questions.userId,
  question: questions.question,
  next_due: questions.nextDue,
  generated_from_question: questions.generatedFromQuestion,
  question_provenance: questions.questionProvenance,
  last_answer: questions.lastAnswer,
  last_answer_summary: questions.lastAnswerSummary,
  concise_answer: questions.conciseAnswer,
  flagged_at: questions.flaggedAt,
  created_at: questions.createdAt,
};

const questionRowSelection = {
  ...questionIdentitySelection,
  review_history: reviewHistorySql,
};

const questionAttemptSelection = {
  id: questionAttempts.id,
  questionId: questionAttempts.questionId,
  question: questionAttempts.question,
  rawAnswer: questionAttempts.rawAnswer,
  answerSummary: questionAttempts.answerSummary,
  correctAnswer: questions.conciseAnswer,
  score: questionAttempts.score,
  justification: questionAttempts.justification,
  submittedAt: questionAttempts.submittedAt,
  resolvedAt: questionAttempts.resolvedAt,
};

const answerEvaluationSelection = {
  id: answerEvaluations.id,
  traceId: answerEvaluations.traceId,
  questionId: questions.id,
  question: answerEvaluations.question,
  answer: answerEvaluations.rawAnswer,
  status: answerEvaluations.status,
  phase: answerEvaluations.phase,
  lastActivityAt: answerEvaluations.lastActivityAt,
  submittedAt: answerEvaluations.submittedAt,
  score: answerEvaluations.score,
  justification: answerEvaluations.justification,
  answerSummary: answerEvaluations.answerSummary,
  correctAnswer: questions.conciseAnswer,
  nextDue: answerEvaluations.nextDue,
  resolvedAt: answerEvaluations.resolvedAt,
  traceCalls: llmTraceInteractions.calls,
};

async function enrichDueQuestionsWithConceptSlugs(
  userId: string,
  items: DueQuestion[],
): Promise<DueQuestion[]> {
  const slugsByQuestionId = await getQuestionConceptSlugs({
    userId,
    questionIds: items.map((item) => item.questionId),
  });

  return items.map((item) => ({
    ...item,
    conceptSlugs: slugsByQuestionId.get(item.questionId) ?? item.conceptSlugs,
  }));
}

function normalizeEmbeddingModel(embeddingModel: string): string {
  return embeddingModel.trim();
}

function normalizeEmbedding(embedding: number[]): number[] {
  return embedding.map((component) => {
    if (!Number.isFinite(component)) {
      throw new Error("Embedding components must be finite numbers");
    }

    return component;
  });
}

function toQuestionEmbedding(row: {
  question: string;
  embeddingModel: string;
  embeddingKind: string;
  sourceVersion: number;
  sourceHash: string;
  isCurrent: boolean;
  embedding: number[];
  projectionX: number | null;
  projectionY: number | null;
  createdAt: number;
  updatedAt: number;
}): QuestionEmbedding {
  return row;
}

async function selectQuestionRows(
  whereClause = sql`true`,
  input: UserContextInput = {},
): Promise<QuestionRow[]> {
  const context = await resolveUserContext(input);

  return db
    .select(questionRowSelection)
    .from(questions)
    .where(and(eq(questions.userId, context.userId), whereClause))
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question));
}

export async function readQuestionEmbeddingProjections(input: {
  embeddingModel?: string;
  embeddingKind?: string;
  currentOnly?: boolean;
  questions?: string[];
  limit?: number;
  offset?: number;
  userId?: string;
} = {}): Promise<QuestionEmbeddingProjection[]> {
  const context = await resolveUserContext(input);
  const questionFilter =
    input.questions === undefined
      ? null
      : Array.from(new Set(input.questions.map((question) => question.trim())))
          .filter(Boolean);
  const model =
    input.embeddingModel === undefined
      ? null
      : normalizeEmbeddingModel(input.embeddingModel);
  const embeddingKind = input.embeddingKind?.trim() || null;
  const limit =
    input.limit === undefined ? null : Math.max(0, Math.floor(input.limit));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));

  if (model !== null && !model) {
    throw new Error("Embedding model is required");
  }

  if (questionFilter?.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      question: questions.question,
      last_score: sql<number | null>`(
        SELECT attempt.score
        FROM question_attempts attempt
        WHERE attempt.question_id = "questions"."id"
        ORDER BY attempt.resolved_at DESC, attempt.id DESC
        LIMIT 1
      )`,
      next_due: questions.nextDue,
      embedding_model: questionEmbeddings.embeddingModel,
      embedding_kind: questionEmbeddings.embeddingKind,
      is_current: questionEmbeddings.isCurrent,
      projection_x: questionEmbeddings.projectionX,
      projection_y: questionEmbeddings.projectionY,
    })
    .from(questions)
    .leftJoin(
      questionEmbeddings,
      and(
        eq(questionEmbeddings.questionId, questions.id),
        eq(questionEmbeddings.userId, questions.userId),
        model === null
          ? sql`true`
          : eq(questionEmbeddings.embeddingModel, model),
        embeddingKind === null
          ? sql`true`
          : eq(questionEmbeddings.embeddingKind, embeddingKind),
        input.currentOnly ? eq(questionEmbeddings.isCurrent, true) : sql`true`,
      ),
    )
    .where(
      and(
        eq(questions.userId, context.userId),
        isNull(questions.flaggedAt),
        questionFilter === null
          ? sql`true`
          : inArray(questions.question, questionFilter),
      ),
    )
    .orderBy(
      asc(questions.nextDue),
      asc(questions.question),
      asc(questionEmbeddings.embeddingModel),
    )
    .limit(limit ?? 2_147_483_647)
    .offset(offset);

  return rows.map((row) => ({
    question: row.question,
    lastScore: row.last_score,
    embeddingModel: row.embedding_model,
    embeddingKind: row.embedding_kind,
    isCurrent: row.is_current,
    projectionX: row.projection_x,
    projectionY: row.projection_y,
  }));
}

export async function upsertQuestionEmbeddings(input: {
  embeddings: Array<{
    question: string;
    embeddingModel: string;
    embeddingKind?: string;
    sourceVersion?: number;
    sourceHash?: string;
    embedding: number[];
  }>;
  now?: number;
  userId?: string;
}): Promise<QuestionEmbedding[]> {
  const context = await resolveUserContext(input);

  if (input.embeddings.length === 0) {
    return [];
  }

  const now = Math.round(input.now ?? Date.now());
  const valuesByKey = new Map<
    string,
    {
      userId: string;
      questionId: string;
      question: string;
      embeddingModel: string;
      embeddingKind: string;
      sourceVersion: number;
      sourceHash: string;
      isCurrent: boolean;
      embedding: number[];
      projectionX: number | null;
      projectionY: number | null;
      createdAt: number;
      updatedAt: number;
    }
  >();

  for (const item of input.embeddings) {
    const model = normalizeEmbeddingModel(item.embeddingModel);

    if (!model) {
      throw new Error("Embedding model is required");
    }

    if (item.embedding.length === 0) {
      throw new Error("Embedding must have at least one component");
    }

    const embeddingKind = item.embeddingKind?.trim() || "question_only";
    const sourceVersion = item.sourceVersion ?? 1;
    const embedding = normalizeEmbedding(item.embedding);
    const projection = projectEmbeddingForPlot(embedding);

    valuesByKey.set(
      `${item.question}\0${model}\0${embeddingKind}\0${sourceVersion}`,
      {
        userId: context.userId,
        questionId: "",
        question: item.question,
        embeddingModel: model,
        embeddingKind,
        sourceVersion,
        sourceHash: item.sourceHash?.trim() ?? "",
        isCurrent: true,
        embedding,
        projectionX: projection?.x ?? null,
        projectionY: projection?.y ?? null,
        createdAt: now,
        updatedAt: now,
      },
    );
  }

  const values = Array.from(valuesByKey.values());
  const ownedQuestions = await selectQuestionRows(
    inArray(
      questions.question,
      Array.from(new Set(values.map((item) => item.question))),
    ),
    { userId: context.userId },
  );
  const ownedQuestionByText = new Map(
    ownedQuestions.map((row) => [row.question, row.question_id]),
  );
  const missingQuestion = values.find(
    (item) => !ownedQuestionByText.has(item.question),
  );

  if (missingQuestion) {
    throw new Error(`Question does not exist: ${missingQuestion.question}`);
  }

  const rows = await db
    .insert(questionEmbeddings)
    .values(
      values.map((value) => ({
        ...value,
        questionId: ownedQuestionByText.get(value.question) ?? "",
      })),
    )
    .onConflictDoUpdate({
      target: [
        questionEmbeddings.userId,
        questionEmbeddings.questionId,
        questionEmbeddings.embeddingModel,
        questionEmbeddings.embeddingKind,
        questionEmbeddings.sourceVersion,
      ],
      set: {
        embedding: sql`excluded.embedding`,
        projectionX: sql`excluded.projection_x`,
        projectionY: sql`excluded.projection_y`,
        sourceHash: sql`excluded.source_hash`,
        isCurrent: true,
        updatedAt: now,
      },
    })
    .returning({
      question: questionEmbeddings.question,
      embeddingModel: questionEmbeddings.embeddingModel,
      embeddingKind: questionEmbeddings.embeddingKind,
      sourceVersion: questionEmbeddings.sourceVersion,
      sourceHash: questionEmbeddings.sourceHash,
      isCurrent: questionEmbeddings.isCurrent,
      embedding: questionEmbeddings.embedding,
      projectionX: questionEmbeddings.projectionX,
      projectionY: questionEmbeddings.projectionY,
      createdAt: questionEmbeddings.createdAt,
      updatedAt: questionEmbeddings.updatedAt,
    });

  return rows.map(toQuestionEmbedding);
}

export async function getDueQuestions(
  now = Date.now(),
  input: DueQuestionsInput = {},
): Promise<DueQuestion[]> {
  const context = await resolveUserContext(input);
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const limit =
    input.limit === undefined ? null : Math.max(0, Math.floor(input.limit));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const rows = await db
    .select(questionRowSelection)
    .from(questions)
    .where(
      and(
        eq(questions.userId, context.userId),
        isNull(questions.flaggedAt),
        lte(questions.nextDue, Math.round(now)),
        activeConceptEligibilityClause(context.userId),
        excludeQuestionIds.length > 0
          ? notInArray(questions.id, excludeQuestionIds)
          : sql`true`,
      ),
    )
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question))
    .limit(limit ?? 2_147_483_647)
    .offset(offset);

  return enrichDueQuestionsWithConceptSlugs(
    context.userId,
    rows
      .map(toDueQuestion)
      .filter((row) => Number.isFinite(row.nextDue) && row.nextDue <= now),
  );
}

export async function countDueQuestions(
  now = Date.now(),
  input: UserContextInput = {},
): Promise<number> {
  const context = await resolveUserContext(input);
  const [{ value = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .where(
      and(
        eq(questions.userId, context.userId),
        isNull(questions.flaggedAt),
        lte(questions.nextDue, Math.round(now)),
        activeConceptEligibilityClause(context.userId),
      ),
    );

  return Number(value) || 0;
}

export async function getNextScheduledQuestionDue(
  now = Date.now(),
  input: DueQuestionsInput = {},
): Promise<number | null> {
  const context = await resolveUserContext(input);
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const [row] = await db
    .select({ nextDue: questions.nextDue })
    .from(questions)
    .where(
      and(
        eq(questions.userId, context.userId),
        isNull(questions.flaggedAt),
        gt(questions.nextDue, Math.round(now)),
        activeConceptEligibilityClause(context.userId),
        excludeQuestionIds.length > 0
          ? notInArray(questions.id, excludeQuestionIds)
          : sql`true`,
      ),
    )
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question))
    .limit(1);

  return row?.nextDue ?? null;
}

export async function hasReviewEligibleQuestions(
  input: UserContextInput = {},
): Promise<boolean> {
  const context = await resolveUserContext(input);
  const [row] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.userId, context.userId),
        isNull(questions.flaggedAt),
        activeConceptEligibilityClause(context.userId),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function getQuestionSnapshot(
  question: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const context = await resolveUserContext(input);
  const [row] = await selectQuestionRows(eq(questions.question, question), {
    userId: context.userId,
  });

  return row
    ? (await enrichDueQuestionsWithConceptSlugs(context.userId, [toDueQuestion(row)]))[0] ?? null
    : null;
}

export async function getQuestionSnapshotById(
  questionId: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const context = await resolveUserContext(input);
  const [row] = await selectQuestionRows(eq(questions.id, questionId), {
    userId: context.userId,
  });

  return row
    ? (await enrichDueQuestionsWithConceptSlugs(context.userId, [toDueQuestion(row)]))[0] ?? null
    : null;
}

export async function flagQuestionForReview(input: {
  questionId: string;
  question: string;
  userId?: string;
  now?: number;
}): Promise<DueQuestion | null> {
  const questionId = input.questionId.trim();
  const normalizedInputQuestion = input.question.trim().replace(/\s+/g, " ");

  if (!questionId || !normalizedInputQuestion) {
    throw new Error("Question is required.");
  }

  const snapshot = await getQuestionSnapshotById(questionId, {
    userId: input.userId,
  });

  if (!snapshot) {
    throw new Error("Question not found.");
  }

  const normalizedSnapshotQuestion = snapshot.question.trim().replace(/\s+/g, " ");

  if (normalizedInputQuestion !== normalizedSnapshotQuestion) {
    throw new Error("Question mismatch.");
  }

  const now = Math.round(input.now ?? Date.now());

  await db
    .update(questions)
    .set({
      flaggedAt: snapshot.flaggedAt ?? now,
      updatedAt: now,
    })
    .where(and(eq(questions.userId, snapshot.userId), eq(questions.id, questionId)));

  return {
    ...snapshot,
    flaggedAt: snapshot.flaggedAt ?? now,
  };
}

export async function getQuestionAttemptsByQuestionIds(
  input: UserContextInput & { questionIds: string[] },
): Promise<Map<string, QuestionAttempt[]>> {
  const context = await resolveUserContext(input);
  const questionIds = Array.from(new Set(input.questionIds)).filter(Boolean);

  if (questionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select(questionAttemptSelection)
    .from(questionAttempts)
    .innerJoin(questions, eq(questions.id, questionAttempts.questionId))
    .where(
      and(
        eq(questionAttempts.userId, context.userId),
        eq(questions.userId, context.userId),
        inArray(questionAttempts.questionId, questionIds),
      ),
    )
    .orderBy(
      asc(questionAttempts.questionId),
      asc(questionAttempts.submittedAt),
      asc(questionAttempts.id),
    );
  const attemptsByQuestionId = new Map<string, QuestionAttempt[]>();

  for (const attempt of rows) {
    if (
      !Number.isFinite(attempt.id) ||
      !Number.isFinite(attempt.score) ||
      !Number.isFinite(attempt.submittedAt) ||
      !Number.isFinite(attempt.resolvedAt)
    ) {
      continue;
    }

    const attempts = attemptsByQuestionId.get(attempt.questionId) ?? [];

    attempts.push(attempt);
    attemptsByQuestionId.set(attempt.questionId, attempts);
  }

  return attemptsByQuestionId;
}

export async function getRecentQuestionAttempts(
  input: UserContextInput & {
    excludeQuestions?: string[];
    limit: number;
  } = {
    limit: 24,
  },
): Promise<QuestionAttempt[]> {
  const context = await resolveUserContext(input);
  const excludeQuestions = Array.from(
    new Set(input.excludeQuestions ?? []),
  ).filter(Boolean);

  const rows = await db
    .select(questionAttemptSelection)
    .from(questionAttempts)
    .innerJoin(questions, eq(questions.id, questionAttempts.questionId))
    .where(
      and(
        eq(questionAttempts.userId, context.userId),
        eq(questions.userId, context.userId),
        excludeQuestions.length > 0
          ? notInArray(questionAttempts.question, excludeQuestions)
          : sql`true`,
      ),
    )
    .orderBy(desc(questionAttempts.submittedAt), desc(questionAttempts.id))
    .limit(Math.max(0, Math.floor(input.limit)));

  return rows.filter(
    (attempt) =>
      Number.isFinite(attempt.id) &&
      Number.isFinite(attempt.score) &&
      Number.isFinite(attempt.submittedAt) &&
      Number.isFinite(attempt.resolvedAt),
  );
}

function toEvaluationPhase(value: string | null): EvaluationPhase | null {
  return value && EVALUATION_PHASES.has(value as EvaluationPhase)
    ? (value as EvaluationPhase)
    : null;
}

function totalTraceCost(callsJson: string | null): number | null {
  if (!callsJson) {
    return null;
  }

  let calls: unknown;

  try {
    calls = JSON.parse(callsJson);
  } catch {
    return null;
  }

  if (!Array.isArray(calls)) {
    return null;
  }

  let total = 0;
  let hasCost = false;

  for (const call of calls) {
    if (!call || typeof call !== "object") {
      continue;
    }

    const cost = (call as { cost?: unknown }).cost;
    const numericCost =
      typeof cost === "number"
        ? cost
        : typeof cost === "string"
          ? Number.parseFloat(cost)
          : Number.NaN;

    if (Number.isFinite(numericCost)) {
      total += numericCost;
      hasCost = true;
    }
  }

  return hasCost ? total : null;
}

function toEvaluationQueueItem(row: {
  id: string;
  traceId: string;
  questionId: string | null;
  question: string;
  answer: string;
  status: string;
  phase: string | null;
  lastActivityAt: number;
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  correctAnswer: string | null;
  nextDue: number | null;
  resolvedAt: number | null;
  traceCalls: string | null;
}): EvaluationQueueItem {
  const status = row.status === "resolved" ? "resolved" : "grading";

  return {
    id: row.id,
    traceId: row.traceId,
    questionId: row.questionId,
    question: row.question,
    answer: row.answer,
    status,
    phase: status === "grading" ? toEvaluationPhase(row.phase) : null,
    lastActivityAt: row.lastActivityAt,
    submittedAt: row.submittedAt,
    score: row.score,
    justification: row.justification,
    answerSummary: row.answerSummary,
    correctAnswer: row.correctAnswer || null,
    resolvedAt: row.resolvedAt,
    nextDue: row.nextDue,
    cost: totalTraceCost(row.traceCalls),
  };
}

export async function createAnswerEvaluationRecord(input: {
  id: string;
  traceId: string;
  userId: string;
  question: string;
  answer: string;
  submittedAt: number;
}): Promise<void> {
  await resolveUserContext({ userId: input.userId });
  const now = Math.round(input.submittedAt);

  await db.insert(answerEvaluations).values({
    id: input.id,
    traceId: input.traceId,
    userId: input.userId,
    question: input.question,
    rawAnswer: input.answer,
    status: "grading",
    phase: "queued",
    lastActivityAt: now,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateAnswerEvaluationPhase(input: {
  id: string;
  phase: EvaluationPhase;
  now?: number;
}): Promise<void> {
  const now = Math.round(input.now ?? Date.now());

  await db
    .update(answerEvaluations)
    .set({
      phase: input.phase,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(answerEvaluations.id, input.id),
        eq(answerEvaluations.status, "grading"),
      ),
    );
}

export async function resolveAnswerEvaluationRecord(input: {
  id: string;
  score: number | null;
  justification: string;
  answerSummary: string;
  nextDue: number | null;
  resolvedAt: number;
}): Promise<void> {
  const resolvedAt = Math.round(input.resolvedAt);

  await db
    .update(answerEvaluations)
    .set({
      status: "resolved",
      phase: null,
      lastActivityAt: resolvedAt,
      score: input.score,
      justification: input.justification,
      answerSummary: input.answerSummary,
      nextDue: input.nextDue === null ? null : Math.round(input.nextDue),
      resolvedAt,
      updatedAt: resolvedAt,
    })
    .where(eq(answerEvaluations.id, input.id));
}

export async function getVisibleAnswerEvaluations(input: UserContextInput & {
  activeSince: number;
  resolvedSince: number;
  limit: number;
}): Promise<EvaluationQueueItem[]> {
  const context = await resolveUserContext(input);
  const activeSince = Math.round(input.activeSince);
  const resolvedSince = Math.round(input.resolvedSince);

  const rows = await db
    .select(answerEvaluationSelection)
    .from(answerEvaluations)
    .leftJoin(
      llmTraceInteractions,
      eq(llmTraceInteractions.id, answerEvaluations.traceId),
    )
    .leftJoin(
      questions,
      and(
        eq(questions.userId, answerEvaluations.userId),
        eq(questions.question, answerEvaluations.question),
      ),
    )
    .where(
      and(
        eq(answerEvaluations.userId, context.userId),
        or(
          and(
            eq(answerEvaluations.status, "grading"),
            gte(answerEvaluations.submittedAt, activeSince),
          ),
          and(
            eq(answerEvaluations.status, "resolved"),
            gte(answerEvaluations.resolvedAt, resolvedSince),
          ),
        ),
      ),
    )
    .orderBy(desc(answerEvaluations.submittedAt))
    .limit(Math.max(0, Math.floor(input.limit)));

  return rows
    .filter(
      (row) =>
        Number.isFinite(row.submittedAt) &&
        Number.isFinite(row.lastActivityAt),
    )
    .map(toEvaluationQueueItem);
}

export async function getActiveAnswerEvaluationQuestionIds(
  input: UserContextInput & { activeSince: number },
): Promise<string[]> {
  const context = await resolveUserContext(input);
  const rows = await db
    .select({ questionId: questions.id })
    .from(answerEvaluations)
    .innerJoin(
      questions,
      and(
        eq(questions.userId, answerEvaluations.userId),
        eq(questions.question, answerEvaluations.question),
      ),
    )
    .where(
      and(
        eq(answerEvaluations.userId, context.userId),
        eq(answerEvaluations.status, "grading"),
        gte(answerEvaluations.submittedAt, Math.round(input.activeSince)),
      ),
    );

  return Array.from(new Set(rows.map((row) => row.questionId)));
}

export async function getAnswerEvaluationsByIds(input: UserContextInput & {
  ids: string[];
}): Promise<EvaluationQueueItem[]> {
  const context = await resolveUserContext(input);
  const ids = Array.from(new Set(input.ids.map((id) => id.trim()).filter(Boolean)));

  if (ids.length === 0) {
    return [];
  }

  const rows = await db
    .select(answerEvaluationSelection)
    .from(answerEvaluations)
    .leftJoin(
      llmTraceInteractions,
      eq(llmTraceInteractions.id, answerEvaluations.traceId),
    )
    .leftJoin(
      questions,
      and(
        eq(questions.userId, answerEvaluations.userId),
        eq(questions.question, answerEvaluations.question),
      ),
    )
    .where(
      and(
        eq(answerEvaluations.userId, context.userId),
        inArray(answerEvaluations.id, ids),
      ),
    )
    .orderBy(desc(answerEvaluations.submittedAt));

  return rows
    .filter(
      (row) =>
        Number.isFinite(row.submittedAt) &&
        Number.isFinite(row.lastActivityAt),
    )
    .map(toEvaluationQueueItem);
}

export async function upsertDueQuestions(input: {
  questions: NormalizedQuestionDraft[];
  sourceQuestion: string | null;
  now: number;
  userId?: string;
}): Promise<DueQuestion[]> {
  const context = await resolveUserContext(input);
  const generatedQuestions = input.questions;

  if (generatedQuestions.length === 0) {
    return [];
  }

  const now = Math.round(input.now);

  await db
    .insert(questions)
    .values(
      generatedQuestions.map((question, index) => ({
        userId: context.userId,
        question: question.question,
        questionSlug: question.questionIdentity,
        nextDue: now + index,
        generatedFromQuestion: input.sourceQuestion,
        questionProvenance: question.questionProvenance ?? "",
        conciseAnswer: question.conciseAnswer ?? "",
        createdAt: now + index,
        updatedAt: now + index,
      })),
    )
    .onConflictDoUpdate({
      target: [questions.userId, questions.questionSlug],
      set: {
        nextDue: sql`excluded.next_due`,
        generatedFromQuestion: sql`coalesce(
          ${questions.generatedFromQuestion},
          excluded.generated_from_question
        )`,
        questionProvenance: sql`coalesce(nullif(${questions.questionProvenance}, ''), excluded.question_provenance)`,
        conciseAnswer: sql`coalesce(nullif(${questions.conciseAnswer}, ''), excluded.concise_answer)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  const rows = await selectQuestionRows(
    inArray(
      questions.questionSlug,
      generatedQuestions.map((question) => question.questionIdentity),
    ),
    { userId: context.userId },
  );
  const dueQuestions = rows.map(toDueQuestion);

  try {
    await assignConceptSlugsForQuestions({
      userId: context.userId,
      questions: dueQuestions.map((row) => {
        const inputQuestion = generatedQuestions.find(
          (question) => question.questionIdentity === questionSlug(row.question),
        );

        return {
          questionId: row.questionId,
          question: row.question,
          conciseAnswer: row.conciseAnswer,
          questionProvenance: row.questionProvenance,
          sourceText: inputQuestion?.sourceText,
          proposedConceptSlugs: inputQuestion?.proposedConceptSlugs,
          fallbackSlug: "needs-concept-tagging",
        };
      }),
    });
  } catch (error) {
    console.warn("[waxon] concept tag assignment failed", error);
  }

  return enrichDueQuestionsWithConceptSlugs(context.userId, dueQuestions);
}

export async function applyEvaluationToPostgres(input: {
  questionId?: string;
  question: string;
  answer: string;
  answerSummary: string;
  correctAnswer: string | null;
  justification: string;
  score: number;
  submittedAt: number;
  now: number;
  userId?: string;
}): Promise<PersistedEvaluation> {
  const context = await resolveUserContext(input);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select(questionIdentitySelection)
      .from(questions)
      .where(
        and(
          eq(questions.userId, context.userId),
          input.questionId
            ? eq(questions.id, input.questionId)
            : eq(questions.question, input.question),
        ),
      )
      .for("update");

    if (!row) {
      return null;
    }

    const previousReviewRows = await tx
      .select({
        ts: questionAttempts.resolvedAt,
        score: questionAttempts.score,
      })
      .from(questionAttempts)
      .where(eq(questionAttempts.questionId, row.question_id))
      .orderBy(desc(questionAttempts.resolvedAt), desc(questionAttempts.id))
      .limit(10);
    const previousReviews = previousReviewRows
      .reverse()
      .filter(
        (entry) =>
          Number.isFinite(entry.ts) &&
          Number.isFinite(entry.score) &&
          entry.ts > 0 &&
          entry.score >= 0 &&
          entry.score <= 10,
      );
    const reviewHistory = [
      ...previousReviews,
      {
        ts: Math.round(input.now),
        score: input.score,
      },
    ].slice(-10);
    const nextDue = scheduleNextReview({
      previousReviews,
      newScore: input.score,
      now: input.now,
    });
    const roundedNextDue = Math.round(nextDue);
    const correctAnswer = input.correctAnswer?.trim().replace(/\s+/g, " ") ?? "";
    const conciseAnswer =
      row.concise_answer || (correctAnswer.length > 0 ? correctAnswer : "");

    await tx
      .update(questions)
      .set({
        nextDue: roundedNextDue,
        lastAnswer: input.answer,
        lastAnswerSummary: input.answerSummary,
        conciseAnswer,
        updatedAt: Math.round(input.now),
      })
      .where(
        and(
          eq(questions.userId, row.user_id),
          eq(questions.id, row.question_id),
        ),
      );

    const [attempt] = await tx
      .insert(questionAttempts)
      .values({
        userId: row.user_id,
        questionId: row.question_id,
        question: row.question,
        rawAnswer: input.answer,
        answerSummary: input.answerSummary,
        score: input.score,
        justification: input.justification,
        submittedAt: Math.round(input.submittedAt),
        resolvedAt: Math.round(input.now),
      })
      .returning({ id: questionAttempts.id });

    if (!attempt) {
      throw new Error("Question attempt was not saved");
    }

    return {
      questionId: row.question_id,
      userId: row.user_id,
      question: row.question,
      reviewHistory,
      nextDue: roundedNextDue,
      generatedFromQuestion: row.generated_from_question || null,
      questionProvenance: row.question_provenance || null,
      lastAnswer: input.answer || null,
      lastAnswerSummary: input.answerSummary || null,
      conciseAnswer,
      flaggedAt: row.flagged_at,
      createdAt: row.created_at,
      conceptSlugs:
        (await getQuestionConceptSlugs({
          userId: row.user_id,
          questionIds: [row.question_id],
        })).get(row.question_id) ?? [],
    };
  });
}
