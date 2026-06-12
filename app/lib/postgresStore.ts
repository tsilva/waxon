import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
import { db, pool } from "@/app/db/client";
import {
  answerEvaluations,
  decks,
  llmTraceInteractions,
  questionAttempts,
  questionEmbeddings,
  questions,
  users,
} from "@/app/db/schema";
import {
  getCurrentUser,
  getDeckIdForUser,
  type AuthenticatedUser,
} from "./auth";
import { scheduleNextReview, serializeReviews } from "./scheduler";
import { questionSlug } from "./questionSlug";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
  projectEmbeddingForPlot,
} from "./embeddingSource";
import type {
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
} from "./reviewTypes";
import { vectorLiteral } from "./vectorLiteral";
import {
  activeConceptEligibilityClause,
  assignConceptSlugsForQuestions,
  ensureFallbackConceptTagForDeck,
  getQuestionConceptSlugs,
} from "./conceptTags";

export type QuestionRow = {
  question_id: string;
  deck_id: string;
  deck_name: string;
  user_id: string;
  question: string;
  reviews: string;
  next_due: number;
  generated_from_question: string | null;
  question_provenance: string;
  last_answer: string;
  last_answer_summary: string;
  concise_answer: string;
  reference_answer: string;
  flagged_at: number | null;
  created_at: number;
  concept_slugs?: string[];
};

export type DueQuestion = {
  questionId: string;
  deckId: string;
  deckName: string;
  userId: string;
  question: string;
  reviews: string;
  nextDue: number;
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
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
  reviews: string;
  embeddingModel: string | null;
  embeddingKind: string | null;
  isCurrent: boolean | null;
  projectionX: number | null;
  projectionY: number | null;
};

export type PersistedEvaluation = {
  questionId: string;
  deckId: string;
  deckName: string;
  userId: string;
  question: string;
  reviews: string;
  nextDue: number;
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  flaggedAt: number | null;
  createdAt: number;
  conceptSlugs: string[];
} | null;

const EVALUATION_PHASES = new Set<EvaluationPhase>([
  "queued",
  "evaluating-answer",
  "saving-evaluation",
  "finalizing",
]);

export type QueuedQuestionsSortKey = "review-date" | "creation-date";

export type QueuedQuestionsPage = {
  items: DueQuestion[];
  total: number;
};

export type DueQuestionsInput = UserContextInput & {
  excludeQuestionIds?: string[];
  limit?: number;
  offset?: number;
};

export type DeckSummary = {
  id: string;
  name: string;
  slug: string;
  coverage: string;
  memory: string;
  inReviewRotation: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  cardCount: number;
  dueCount: number;
  lastReviewedAt: number | null;
};

const LEGACY_QUESTIONS_FILE = path.join(process.cwd(), "data", "questions.csv");
const DEFAULT_DECK = {
  id: "deep-learning",
  name: "Deep Learning",
  slug: "deep-learning",
};

const seededUserIds = new Set<string>();

type UserContextInput = {
  user?: AuthenticatedUser;
  userId?: string;
  deckId?: string;
  deckScope?: "default" | "rotation" | "all";
};

type UserContext = {
  user: AuthenticatedUser | null;
  userId: string;
  deckId: string;
};

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }

      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readLegacyCsvQuestions(): Array<{
  question: string;
  reviews: string;
  nextDue: number;
}> {
  if (!existsSync(LEGACY_QUESTIONS_FILE)) {
    return [];
  }

  const rows = parseCsvRows(readFileSync(LEGACY_QUESTIONS_FILE, "utf8"));
  const header = rows[0] ?? [];
  const questionIndex = header.indexOf("question");
  const reviewsIndex = header.indexOf("reviews");
  const nextDueIndex = header.indexOf("next_due");

  if (questionIndex === -1) {
    return [];
  }

  return rows
    .slice(1)
    .filter((row) => row[questionIndex]?.trim())
    .map((row) => {
      const nextDue = Number(nextDueIndex === -1 ? 0 : row[nextDueIndex]);

      return {
        question: row[questionIndex] ?? "",
        reviews: reviewsIndex === -1 ? "" : (row[reviewsIndex] ?? ""),
        nextDue: Number.isFinite(nextDue) ? Math.round(nextDue) : 0,
      };
    });
}

async function resolveUserContext(input: UserContextInput = {}): Promise<UserContext> {
  const user = input.user ?? (input.userId ? null : await getCurrentUser());
  const userId = input.userId ?? user?.id;

  if (!userId) {
    throw new Error("User id is required.");
  }

  return {
    user,
    userId,
    deckId: getDeckIdForUser(userId),
  };
}

function toDueQuestion(row: QuestionRow): DueQuestion {
  return {
    questionId: row.question_id,
    deckId: row.deck_id,
    deckName: row.deck_name,
    userId: row.user_id,
    question: row.question,
    reviews: row.reviews,
    nextDue: row.next_due,
    generatedFromQuestion: row.generated_from_question || null,
    questionProvenance: row.question_provenance || null,
    lastAnswer: row.last_answer || null,
    lastAnswerSummary: row.last_answer_summary || null,
    conciseAnswer: row.concise_answer || null,
    referenceAnswer: row.reference_answer || null,
    flaggedAt: row.flagged_at,
    createdAt: row.created_at,
    conceptSlugs: row.concept_slugs ?? [],
  };
}

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

function deckSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "untitled-deck";
}

function deckIdForSlug(userId: string, slug: string): string {
  return `${userId}:${slug}`;
}

function normalizedDeckName(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

async function uniqueDeckSlug(userId: string, preferredSlug: string): Promise<string> {
  const rows = await db
    .select({ slug: decks.slug })
    .from(decks)
    .where(eq(decks.userId, userId));
  const existingSlugs = new Set(rows.map((row) => row.slug));

  if (!existingSlugs.has(preferredSlug)) {
    return preferredSlug;
  }

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${preferredSlug}-${suffix}`;

    if (!existingSlugs.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not create a unique deck slug.");
}

async function assertDeckNameAvailable(input: {
  userId: string;
  name: string;
  excludeDeckId?: string;
}) {
  const nameKey = normalizedDeckName(input.name);
  const rows = await db
    .select({ id: decks.id, name: decks.name })
    .from(decks)
    .where(and(eq(decks.userId, input.userId), isNull(decks.archivedAt)));

  if (
    rows.some(
      (row) =>
        row.id !== input.excludeDeckId && normalizedDeckName(row.name) === nameKey,
    )
  ) {
    throw new Error("Deck name already exists.");
  }
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
  return {
    question: row.question,
    embeddingModel: row.embeddingModel,
    embeddingKind: row.embeddingKind,
    sourceVersion: row.sourceVersion,
    sourceHash: row.sourceHash,
    isCurrent: row.isCurrent,
    embedding: row.embedding,
    projectionX: row.projectionX,
    projectionY: row.projectionY,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function seedCurrentUserAndDeck(context: UserContext): Promise<void> {
  const now = Date.now();

  if (context.user) {
    await db
      .insert(users)
      .values({
        id: context.user.id,
        displayName: context.user.displayName,
        email: context.user.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          displayName: context.user.displayName,
          email: context.user.email,
          updatedAt: now,
        },
      });
  }

  await db
    .insert(decks)
    .values({
      id: context.deckId,
      userId: context.userId,
      name: DEFAULT_DECK.name,
      slug: DEFAULT_DECK.slug,
      inReviewRotation: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: decks.id,
      set: {
        userId: context.userId,
        name: DEFAULT_DECK.name,
        slug: DEFAULT_DECK.slug,
        updatedAt: now,
      },
    });
}

async function copyDefaultDeckEmbeddingsToUserDeck(
  context: UserContext,
  now = Math.round(Date.now()),
): Promise<void> {
  if (context.deckId === DEFAULT_DECK.id) {
    return;
  }

  await db.execute(sql`
    INSERT INTO question_embeddings (
      deck_id,
      question_id,
      question,
      embedding_model,
      embedding_kind,
      source_version,
      source_hash,
      is_current,
      embedding,
      projection_x,
      projection_y,
      created_at,
      updated_at
    )
    SELECT
      ${context.deckId},
      target_question.id,
      target_question.question,
      source_embedding.embedding_model,
      source_embedding.embedding_kind,
      source_embedding.source_version,
      source_embedding.source_hash,
      source_embedding.is_current,
      source_embedding.embedding,
      source_embedding.projection_x,
      source_embedding.projection_y,
      source_embedding.created_at,
      ${now}
    FROM question_embeddings source_embedding
    INNER JOIN questions source_question
      ON source_question.id = source_embedding.question_id
      AND source_question.deck_id = source_embedding.deck_id
    INNER JOIN questions target_question
      ON target_question.deck_id = ${context.deckId}
      AND target_question.question = source_question.question
    WHERE source_embedding.deck_id = ${DEFAULT_DECK.id}
    ON CONFLICT (
      deck_id,
      question_id,
      embedding_model,
      embedding_kind,
      source_version
    )
    DO UPDATE SET
      question = excluded.question,
      source_hash = excluded.source_hash,
      is_current = excluded.is_current,
      embedding = excluded.embedding,
      projection_x = excluded.projection_x,
      projection_y = excluded.projection_y,
      updated_at = excluded.updated_at
  `);
}

async function ensureSeedData(input: UserContextInput = {}): Promise<UserContext> {
  const context = await resolveUserContext(input);

  if (seededUserIds.has(context.userId)) {
    return context;
  }

  await seedCurrentUserAndDeck(context);

  const [{ value: questionCount = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .where(eq(questions.deckId, context.deckId));

  if (questionCount > 0) {
    await copyDefaultDeckEmbeddingsToUserDeck(context);
    await ensureFallbackConceptTagForDeck({
      userId: context.userId,
      deckId: context.deckId,
      slug: DEFAULT_DECK.slug,
    });
    seededUserIds.add(context.userId);
    return context;
  }

  const seedRows = readLegacyCsvQuestions();

  if (seedRows.length === 0) {
    seededUserIds.add(context.userId);
    return context;
  }

  await db
    .insert(questions)
    .values(
      seedRows.map((row) => ({
        deckId: context.deckId,
        question: row.question,
        questionSlug: questionSlug(row.question),
        reviews: row.reviews,
        nextDue: row.nextDue,
      })),
    )
    .onConflictDoNothing();

  await copyDefaultDeckEmbeddingsToUserDeck(context);
  await ensureFallbackConceptTagForDeck({
    userId: context.userId,
    deckId: context.deckId,
    slug: DEFAULT_DECK.slug,
  });

  seededUserIds.add(context.userId);
  return context;
}

function questionDeckWhereClause(context: UserContext, input: UserContextInput) {
  if (input.deckId) {
    return eq(questions.deckId, input.deckId);
  }

  if (input.deckScope === "all") {
    return sql`true`;
  }

  if (input.deckScope === "rotation") {
    return and(eq(decks.inReviewRotation, true), isNull(decks.archivedAt));
  }

  return eq(questions.deckId, context.deckId);
}

async function selectQuestionRows(
  whereClause = sql`true`,
  input: UserContextInput = {},
): Promise<QuestionRow[]> {
  const context = await ensureSeedData(input);
  const deckWhereClause = questionDeckWhereClause(context, input);

  const rows = await db
    .select({
      question_id: questions.id,
      deck_id: questions.deckId,
      deck_name: decks.name,
      user_id: decks.userId,
      question: questions.question,
      reviews: questions.reviews,
      next_due: questions.nextDue,
      generated_from_question: questions.generatedFromQuestion,
      question_provenance: questions.questionProvenance,
      last_answer: questions.lastAnswer,
      last_answer_summary: questions.lastAnswerSummary,
      concise_answer: questions.conciseAnswer,
      reference_answer: questions.referenceAnswer,
      flagged_at: questions.flaggedAt,
      created_at: questions.createdAt,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(decks.userId, context.userId),
        deckWhereClause,
        whereClause,
      ),
    )
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question));

  return rows;
}

export async function ensureQuestionsDatabase(): Promise<void> {
  await ensureSeedData();
}

async function resolveTargetDeckId(
  context: UserContext,
  deckId?: string,
): Promise<string> {
  const requestedDeckId = deckId?.trim();

  if (!requestedDeckId || requestedDeckId === context.deckId) {
    return context.deckId;
  }

  const [row] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(
      and(
        eq(decks.id, requestedDeckId),
        eq(decks.userId, context.userId),
        isNull(decks.archivedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error("Deck not found.");
  }

  return row.id;
}

export async function resolveOwnedDeckId(
  input: UserContextInput = {},
): Promise<string> {
  const context = await ensureSeedData(input);

  return resolveTargetDeckId(context, input.deckId);
}

function toDeckSummary(row: {
  id: string;
  name: string;
  slug: string;
  coverage: string;
  memory: string;
  inReviewRotation: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  cardCount: number;
  dueCount: number;
  lastReviewedAt: number | null;
}): DeckSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    coverage: row.coverage,
    memory: row.memory,
    inReviewRotation: row.inReviewRotation,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cardCount: Number(row.cardCount) || 0,
    dueCount: Number(row.dueCount) || 0,
    lastReviewedAt: row.lastReviewedAt,
  };
}

export async function listDecks(
  input: UserContextInput = {},
): Promise<DeckSummary[]> {
  const context = await ensureSeedData(input);
  const now = Math.round(Date.now());
  const rows = await db.execute(sql`
    WITH user_decks AS (
      SELECT *
      FROM ${decks}
      WHERE ${decks.userId} = ${context.userId}
        AND ${decks.archivedAt} IS NULL
    ),
    question_counts AS (
      SELECT
        ${questions.deckId} AS deck_id,
        count(*)::int AS card_count,
        count(*) FILTER (WHERE ${questions.nextDue} <= ${now})::int AS due_count
      FROM ${questions}
      INNER JOIN user_decks ON user_decks.id = ${questions.deckId}
      WHERE ${questions.flaggedAt} IS NULL
      GROUP BY ${questions.deckId}
    ),
    attempt_counts AS (
      SELECT
        ${questionAttempts.deckId} AS deck_id,
        max(${questionAttempts.resolvedAt}) AS last_reviewed_at
      FROM ${questionAttempts}
      INNER JOIN user_decks ON user_decks.id = ${questionAttempts.deckId}
      GROUP BY ${questionAttempts.deckId}
    )
    SELECT
      user_decks.id AS id,
      user_decks.name AS name,
      user_decks.slug AS slug,
      user_decks.coverage AS coverage,
      user_decks.memory AS memory,
      user_decks.in_review_rotation AS "inReviewRotation",
      user_decks.archived_at AS "archivedAt",
      user_decks.created_at AS "createdAt",
      user_decks.updated_at AS "updatedAt",
      coalesce(question_counts.card_count, 0)::int AS "cardCount",
      coalesce(question_counts.due_count, 0)::int AS "dueCount",
      attempt_counts.last_reviewed_at AS "lastReviewedAt"
    FROM user_decks
    LEFT JOIN question_counts ON question_counts.deck_id = user_decks.id
    LEFT JOIN attempt_counts ON attempt_counts.deck_id = user_decks.id
    ORDER BY user_decks.updated_at DESC, user_decks.name ASC
  `);

  return rows.rows.map((row) =>
    toDeckSummary({
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      coverage: String(row.coverage),
      memory: String(row.memory),
      inReviewRotation: Boolean(row.inReviewRotation),
      archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      cardCount: Number(row.cardCount),
      dueCount: Number(row.dueCount),
      lastReviewedAt:
        row.lastReviewedAt === null ? null : Number(row.lastReviewedAt),
    }),
  );
}

export async function createDeck(input: {
  name: string;
  coverage?: string;
  inReviewRotation?: boolean;
  userId?: string;
}): Promise<DeckSummary> {
  const context = await ensureSeedData(input);
  const name = input.name.trim();
  const coverage = input.coverage?.trim() ?? "";

  if (!name) {
    throw new Error("Deck name is required.");
  }

  await assertDeckNameAvailable({ userId: context.userId, name });

  const slug = await uniqueDeckSlug(context.userId, deckSlug(name));
  const now = Math.round(Date.now());
  const deckId = deckIdForSlug(context.userId, slug);

  await db.insert(decks).values({
    id: deckId,
    userId: context.userId,
    name,
    slug,
    coverage,
    memory: "",
    inReviewRotation: input.inReviewRotation ?? false,
    createdAt: now,
    updatedAt: now,
  });

  const deck = (await listDecks({ userId: context.userId })).find(
    (item) => item.id === deckId,
  );

  if (!deck) {
    throw new Error("Created deck could not be loaded.");
  }

  return deck;
}

export async function updateDeck(input: {
  deckId: string;
  name?: string;
  coverage?: string;
  memory?: string;
  inReviewRotation?: boolean;
  userId?: string;
}): Promise<DeckSummary> {
  const context = await ensureSeedData(input);
  const currentDeck = (await listDecks({ userId: context.userId })).find(
    (deck) => deck.id === input.deckId,
  );

  if (!currentDeck) {
    throw new Error("Deck not found.");
  }

  const hasNameUpdate = input.name !== undefined;
  const nextName = input.name?.trim();

  if (hasNameUpdate && !nextName) {
    throw new Error("Deck name is required.");
  }

  if (nextName) {
    await assertDeckNameAvailable({
      userId: context.userId,
      name: nextName,
      excludeDeckId: input.deckId,
    });
  }

  const now = Math.round(Date.now());

  await db
    .update(decks)
    .set({
      ...(nextName ? { name: nextName } : {}),
      ...(input.coverage === undefined ? {} : { coverage: input.coverage.trim() }),
      ...(input.memory === undefined ? {} : { memory: input.memory.trim() }),
      ...(input.inReviewRotation === undefined
        ? {}
        : { inReviewRotation: input.inReviewRotation }),
      updatedAt: now,
    })
    .where(and(eq(decks.id, input.deckId), eq(decks.userId, context.userId)));

  const deck = (await listDecks({ userId: context.userId })).find(
    (item) => item.id === input.deckId,
  );

  if (!deck) {
    throw new Error("Updated deck could not be loaded.");
  }

  return deck;
}

export async function deleteDeck(input: {
  deckId: string;
  userId?: string;
}): Promise<void> {
  const context = await ensureSeedData(input);
  const currentDeck = (await listDecks({ userId: context.userId })).find(
    (deck) => deck.id === input.deckId,
  );

  if (!currentDeck) {
    throw new Error("Deck not found.");
  }

  if (currentDeck.id === context.deckId) {
    throw new Error("The current Deep Learning deck cannot be deleted.");
  }

  await db
    .delete(decks)
    .where(and(eq(decks.id, input.deckId), eq(decks.userId, context.userId)));
}

export async function readQuestions(
  input: UserContextInput = {},
): Promise<QuestionRow[]> {
  return selectQuestionRows(sql`true`, input);
}

export async function readQuestionEmbeddingProjections(input: {
  deckId?: string;
  embeddingModel?: string;
  embeddingKind?: string;
  currentOnly?: boolean;
  questions?: string[];
  limit?: number;
  offset?: number;
  userId?: string;
} = {}): Promise<QuestionEmbeddingProjection[]> {
  const context = await ensureSeedData(input);
  const targetDeckId = input.deckId?.trim() || context.deckId;
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
      reviews: questions.reviews,
      next_due: questions.nextDue,
      embedding_model: questionEmbeddings.embeddingModel,
      embedding_kind: questionEmbeddings.embeddingKind,
      is_current: questionEmbeddings.isCurrent,
      projection_x: questionEmbeddings.projectionX,
      projection_y: questionEmbeddings.projectionY,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .leftJoin(
      questionEmbeddings,
      and(
        eq(questionEmbeddings.questionId, questions.id),
        eq(questionEmbeddings.deckId, questions.deckId),
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
        eq(questions.deckId, targetDeckId),
        isNull(questions.flaggedAt),
        eq(decks.userId, context.userId),
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
    reviews: row.reviews,
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
  deckId?: string;
  now?: number;
  userId?: string;
}): Promise<QuestionEmbedding[]> {
  const context = await ensureSeedData(input);
  const targetDeckId = await resolveTargetDeckId(context, input.deckId);

  if (input.embeddings.length === 0) {
    return [];
  }

  const now = Math.round(input.now ?? Date.now());
  const valuesByKey = new Map<
    string,
    {
      deckId: string;
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
        deckId: targetDeckId,
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
    { userId: context.userId, deckId: targetDeckId },
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
        questionEmbeddings.deckId,
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
  const context = await ensureSeedData(input);
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const limit =
    input.limit === undefined ? null : Math.max(0, Math.floor(input.limit));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const whereClause = and(
    eq(decks.userId, context.userId),
    input.deckId ? eq(questions.deckId, input.deckId) : activeConceptEligibilityClause(context.userId),
    isNull(decks.archivedAt),
    isNull(questions.flaggedAt),
    lte(questions.nextDue, Math.round(now)),
    excludeQuestionIds.length > 0
      ? notInArray(questions.id, excludeQuestionIds)
      : sql`true`,
  );
  const rows = await db
    .select({
      question_id: questions.id,
      deck_id: questions.deckId,
      deck_name: decks.name,
      user_id: decks.userId,
      question: questions.question,
      reviews: questions.reviews,
      next_due: questions.nextDue,
      generated_from_question: questions.generatedFromQuestion,
      question_provenance: questions.questionProvenance,
      last_answer: questions.lastAnswer,
      last_answer_summary: questions.lastAnswerSummary,
      concise_answer: questions.conciseAnswer,
      reference_answer: questions.referenceAnswer,
      flagged_at: questions.flaggedAt,
      created_at: questions.createdAt,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(whereClause)
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question))
    .limit(limit ?? 2_147_483_647)
    .offset(offset);

  return enrichDueQuestionsWithConceptSlugs(
    context.userId,
    rows
      .map(toDueQuestion)
      .filter((row) => Number.isFinite(row.nextDue) && row.nextDue <= now)
      .sort(
        (a, b) =>
          a.nextDue - b.nextDue ||
          a.createdAt - b.createdAt ||
          a.question.localeCompare(b.question),
      ),
  );
}

export async function countDueQuestions(
  now = Date.now(),
  input: UserContextInput = {},
): Promise<number> {
  const context = await ensureSeedData(input);
  const [{ value = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(decks.userId, context.userId),
        input.deckId
          ? eq(questions.deckId, input.deckId)
          : activeConceptEligibilityClause(context.userId),
        isNull(decks.archivedAt),
        isNull(questions.flaggedAt),
        lte(questions.nextDue, Math.round(now)),
      ),
    );

  return Number(value) || 0;
}

export async function getNextScheduledQuestionDue(
  now = Date.now(),
  input: DueQuestionsInput = {},
): Promise<number | null> {
  const context = await ensureSeedData(input);
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const [row] = await db
    .select({ nextDue: questions.nextDue })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(decks.userId, context.userId),
        input.deckId
          ? eq(questions.deckId, input.deckId)
          : activeConceptEligibilityClause(context.userId),
        isNull(decks.archivedAt),
        isNull(questions.flaggedAt),
        gt(questions.nextDue, Math.round(now)),
        excludeQuestionIds.length > 0
          ? notInArray(questions.id, excludeQuestionIds)
          : sql`true`,
      ),
    )
    .orderBy(asc(questions.nextDue), asc(questions.createdAt), asc(questions.question))
    .limit(1);

  return row?.nextDue ?? null;
}

export async function getQueuedQuestionsPage(
  input: UserContextInput & {
    excludeQuestionIds?: string[];
    limit: number;
    offset: number;
    sortKey: QueuedQuestionsSortKey;
  },
): Promise<QueuedQuestionsPage> {
  const context = await ensureSeedData(input);
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const whereClause = and(
    eq(decks.userId, context.userId),
    input.deckId ? sql`true` : activeConceptEligibilityClause(context.userId),
    input.deckId ? eq(questions.deckId, input.deckId) : sql`true`,
    isNull(questions.flaggedAt),
    isNull(decks.archivedAt),
    excludeQuestionIds.length > 0
      ? notInArray(questions.id, excludeQuestionIds)
      : sql`true`,
  );
  const orderBy =
    input.sortKey === "creation-date"
      ? [desc(questions.createdAt), asc(questions.question)]
      : [asc(questions.nextDue), asc(questions.createdAt), asc(questions.question)];
  const [{ value: total = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(whereClause);

  const rows = await db
    .select({
      question_id: questions.id,
      deck_id: questions.deckId,
      deck_name: decks.name,
      user_id: decks.userId,
      question: questions.question,
      reviews: questions.reviews,
      next_due: questions.nextDue,
      generated_from_question: questions.generatedFromQuestion,
      question_provenance: questions.questionProvenance,
      last_answer: questions.lastAnswer,
      last_answer_summary: questions.lastAnswerSummary,
      concise_answer: questions.conciseAnswer,
      reference_answer: questions.referenceAnswer,
      flagged_at: questions.flaggedAt,
      created_at: questions.createdAt,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(Math.max(0, Math.floor(input.limit)))
    .offset(Math.max(0, Math.floor(input.offset)));

  return {
    items: await enrichDueQuestionsWithConceptSlugs(
      context.userId,
      rows.map(toDueQuestion).filter((row) => Number.isFinite(row.nextDue)),
    ),
    total,
  };
}

function rawQuestionRowToDueQuestion(row: {
  question_id: string;
  deck_id: string;
  deck_name: string;
  user_id: string;
  question: string;
  reviews: string;
  next_due: number | string;
  generated_from_question: string | null;
  question_provenance: string;
  last_answer: string;
  last_answer_summary: string;
  concise_answer: string;
  reference_answer: string;
  flagged_at: number | string | null;
  created_at: number | string;
}): DueQuestion {
  return toDueQuestion({
    ...row,
    next_due: Number(row.next_due),
    flagged_at: row.flagged_at === null ? null : Number(row.flagged_at),
    created_at: Number(row.created_at),
  });
}

export async function getQueuedQuestionsByEmbeddingProximityPage(
  input: UserContextInput & {
    queryEmbedding: number[];
    excludeQuestionIds?: string[];
    limit: number;
    offset: number;
    maxResults: number;
    embeddingModel?: string;
    embeddingKind?: string;
    sourceVersion?: number;
  },
): Promise<QueuedQuestionsPage> {
  const context = await ensureSeedData(input);
  const targetDeckId = input.deckId
    ? await resolveTargetDeckId(context, input.deckId)
    : null;
  const queryEmbedding = normalizeEmbedding(input.queryEmbedding);

  if (queryEmbedding.length !== DEDUPE_EMBEDDING_DIMENSIONS) {
    throw new Error("Search query embedding has an unexpected dimension.");
  }

  const model = normalizeEmbeddingModel(
    input.embeddingModel ?? process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
  );
  const embeddingKind = input.embeddingKind?.trim() || DEDUPE_EMBEDDING_KIND;
  const sourceVersion = input.sourceVersion ?? DEDUPE_SOURCE_VERSION;
  const excludeQuestionIds = Array.from(
    new Set(input.excludeQuestionIds ?? []),
  ).filter(Boolean);
  const maxResults = Math.max(0, Math.floor(input.maxResults));
  const offset = Math.max(0, Math.floor(input.offset));
  const requestedLimit = Math.max(0, Math.floor(input.limit));
  const buildWhereClause = (input: {
    userIndex: number;
    modelIndex: number;
    kindIndex: number;
    versionIndex: number;
    startIndex: number;
  }) => {
    const params: unknown[] = [];
    const clauses = [
      `d.user_id = $${input.userIndex}`,
      `d.archived_at IS NULL`,
      `q.flagged_at IS NULL`,
      `qe.embedding_model = $${input.modelIndex}`,
      `qe.embedding_kind = $${input.kindIndex}`,
      `qe.source_version = $${input.versionIndex}`,
      `qe.is_current = true`,
    ];
    let paramIndex = input.startIndex;

    if (!targetDeckId) {
      clauses.push(`exists (
          select 1
          from question_concept_tags qct
          join concept_tags ct on ct.id = qct.concept_tag_id
          where qct.question_id = q.id
            and ct.user_id = $${input.userIndex}
            and ct.active = true
        )`);
    }

    if (targetDeckId) {
      clauses.push(`q.deck_id = $${paramIndex}`);
      params.push(targetDeckId);
      paramIndex += 1;
    }

    if (excludeQuestionIds.length > 0) {
      clauses.push(
        `q.id NOT IN (${excludeQuestionIds
          .map(() => `$${paramIndex++}`)
          .join(", ")})`,
      );
      params.push(...excludeQuestionIds);
    }

    return {
      sql: clauses.join("\n        AND "),
      params,
    };
  };
  const countWhere = buildWhereClause({
    userIndex: 1,
    modelIndex: 2,
    kindIndex: 3,
    versionIndex: 4,
    startIndex: 5,
  });
  const countResult = await pool.query(
    `
      SELECT count(*) AS value
      FROM question_embeddings qe
      JOIN questions q ON q.id = qe.question_id AND q.deck_id = qe.deck_id
      JOIN decks d ON d.id = q.deck_id
      WHERE ${countWhere.sql}
    `,
    [context.userId, model, embeddingKind, sourceVersion, ...countWhere.params],
  );
  const total = Math.min(
    maxResults,
    Number(countResult.rows[0]?.value ?? 0),
  );
  const limit = Math.min(requestedLimit, Math.max(0, maxResults - offset));

  if (limit === 0 || offset >= maxResults) {
    return { items: [], total };
  }

  const rowWhere = buildWhereClause({
    userIndex: 1,
    modelIndex: 3,
    kindIndex: 4,
    versionIndex: 5,
    startIndex: 6,
  });
  const rowsResult = await pool.query(
    `
      SELECT
        q.id AS question_id,
        q.deck_id,
        d.name AS deck_name,
        d.user_id,
        q.question,
        q.reviews,
        q.next_due,
        q.generated_from_question,
        q.question_provenance,
        q.last_answer,
        q.last_answer_summary,
        q.concise_answer,
        q.reference_answer,
        q.flagged_at,
        q.created_at,
        qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> $2::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS}) AS distance
      FROM question_embeddings qe
      JOIN questions q ON q.id = qe.question_id AND q.deck_id = qe.deck_id
      JOIN decks d ON d.id = q.deck_id
      WHERE ${rowWhere.sql}
      ORDER BY distance ASC, q.question ASC
      LIMIT $${6 + rowWhere.params.length}
      OFFSET $${7 + rowWhere.params.length}
    `,
    [
      context.userId,
      vectorLiteral(queryEmbedding),
      model,
      embeddingKind,
      sourceVersion,
      ...rowWhere.params,
      limit,
      offset,
    ],
  );

  return {
    items: await enrichDueQuestionsWithConceptSlugs(
      context.userId,
      rowsResult.rows.map(rawQuestionRowToDueQuestion),
    ),
    total,
  };
}

export async function getQuestionSnapshot(
  question: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const context = await ensureSeedData(input);
  const [row] = await selectQuestionRows(eq(questions.question, question), {
    ...input,
    deckScope: "all",
  });

  return row
    ? (await enrichDueQuestionsWithConceptSlugs(context.userId, [toDueQuestion(row)]))[0] ?? null
    : null;
}

export async function getQuestionSnapshotById(
  questionId: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const context = await ensureSeedData(input);
  const [row] = await selectQuestionRows(eq(questions.id, questionId), {
    ...input,
    deckScope: "all",
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
    .where(and(eq(questions.deckId, snapshot.deckId), eq(questions.id, questionId)));

  return {
    ...snapshot,
    flaggedAt: snapshot.flaggedAt ?? now,
  };
}

export async function getQuestionAttemptsByQuestionIds(
  input: UserContextInput & { questionIds: string[] },
): Promise<Map<string, QuestionAttempt[]>> {
  const context = await ensureSeedData(input);
  const questionIds = Array.from(new Set(input.questionIds)).filter(Boolean);

  if (questionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: questionAttempts.id,
      questionId: questionAttempts.questionId,
      deckId: questionAttempts.deckId,
      question: questionAttempts.question,
      rawAnswer: questionAttempts.rawAnswer,
      answerSummary: questionAttempts.answerSummary,
      correctAnswer: questions.conciseAnswer,
      score: questionAttempts.score,
      justification: questionAttempts.justification,
      submittedAt: questionAttempts.submittedAt,
      resolvedAt: questionAttempts.resolvedAt,
    })
    .from(questionAttempts)
    .innerJoin(
      questions,
      and(
        eq(questions.deckId, questionAttempts.deckId),
        eq(questions.id, questionAttempts.questionId),
      ),
    )
    .where(
      and(
        inArray(
          questionAttempts.deckId,
          db
            .select({ id: decks.id })
            .from(decks)
            .where(eq(decks.userId, context.userId)),
        ),
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
  const context = await ensureSeedData(input);
  const excludeQuestions = Array.from(
    new Set(input.excludeQuestions ?? []),
  ).filter(Boolean);
  const deckWhereClause = input.deckId
    ? eq(decks.id, input.deckId)
    : input.deckScope === "rotation"
      ? isNull(decks.archivedAt)
      : input.deckScope === "all"
        ? sql`true`
        : eq(decks.id, context.deckId);
  const questionWhereClause =
    input.deckId || input.deckScope !== "rotation"
      ? sql`true`
      : activeConceptEligibilityClause(context.userId);

  const rows = await db
    .select({
      id: questionAttempts.id,
      questionId: questionAttempts.questionId,
      deckId: questionAttempts.deckId,
      question: questionAttempts.question,
      rawAnswer: questionAttempts.rawAnswer,
      answerSummary: questionAttempts.answerSummary,
      correctAnswer: questions.conciseAnswer,
      score: questionAttempts.score,
      justification: questionAttempts.justification,
      submittedAt: questionAttempts.submittedAt,
      resolvedAt: questionAttempts.resolvedAt,
    })
    .from(questionAttempts)
    .innerJoin(
      questions,
      and(
        eq(questions.deckId, questionAttempts.deckId),
        eq(questions.id, questionAttempts.questionId),
      ),
    )
    .where(
      and(
        inArray(
          questionAttempts.deckId,
          db
            .select({ id: decks.id })
            .from(decks)
            .where(and(eq(decks.userId, context.userId), deckWhereClause)),
        ),
        excludeQuestions.length > 0
          ? notInArray(questionAttempts.question, excludeQuestions)
          : sql`true`,
        questionWhereClause,
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

function toEvaluationQueueItem(row: {
  id: string;
  traceId: string;
  deckId: string;
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
    questionId: null,
    deckId: row.deckId,
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

export async function createAnswerEvaluationRecord(input: {
  id: string;
  traceId: string;
  userId: string;
  deckId: string;
  question: string;
  answer: string;
  submittedAt: number;
}): Promise<void> {
  await ensureSeedData({ userId: input.userId });
  const now = Math.round(input.submittedAt);

  await db.insert(answerEvaluations).values({
    id: input.id,
    traceId: input.traceId,
    userId: input.userId,
    deckId: input.deckId,
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
  const context = await ensureSeedData(input);
  const deckWhereClause = input.deckId
    ? eq(decks.id, input.deckId)
    : and(isNull(decks.archivedAt), activeConceptEligibilityClause(context.userId));
  const activeSince = Math.round(input.activeSince);
  const resolvedSince = Math.round(input.resolvedSince);

  const rows = await db
    .select({
      id: answerEvaluations.id,
      traceId: answerEvaluations.traceId,
      deckId: answerEvaluations.deckId,
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
    })
    .from(answerEvaluations)
    .innerJoin(decks, eq(decks.id, answerEvaluations.deckId))
    .leftJoin(
      llmTraceInteractions,
      eq(llmTraceInteractions.id, answerEvaluations.traceId),
    )
    .innerJoin(
      questions,
      and(
        eq(questions.deckId, answerEvaluations.deckId),
        eq(questions.question, answerEvaluations.question),
      ),
    )
    .where(
      and(
        eq(answerEvaluations.userId, context.userId),
        deckWhereClause,
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

export async function getAnswerEvaluationsByIds(input: UserContextInput & {
  ids: string[];
}): Promise<EvaluationQueueItem[]> {
  const context = await ensureSeedData(input);
  const ids = Array.from(new Set(input.ids.map((id) => id.trim()).filter(Boolean)));

  if (ids.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: answerEvaluations.id,
      traceId: answerEvaluations.traceId,
      deckId: answerEvaluations.deckId,
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
    })
    .from(answerEvaluations)
    .leftJoin(
      llmTraceInteractions,
      eq(llmTraceInteractions.id, answerEvaluations.traceId),
    )
    .innerJoin(
      questions,
      and(
        eq(questions.deckId, answerEvaluations.deckId),
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

export async function saveReferenceAnswer(input: {
  questionId: string;
  question: string;
  answer: string;
  now: number;
  userId?: string;
}): Promise<void> {
  const context = await ensureSeedData(input);

  await db
    .update(questions)
    .set({
      referenceAnswer: input.answer,
      updatedAt: Math.round(input.now),
    })
    .where(
      and(
        inArray(
          questions.deckId,
          db
            .select({ id: decks.id })
            .from(decks)
            .where(eq(decks.userId, context.userId)),
        ),
        eq(questions.id, input.questionId),
        eq(questions.question, input.question),
      ),
    );
}

export type QuestionInput = {
  question: string;
  conciseAnswer?: string | null;
  questionProvenance?: string | null;
  proposedConceptSlugs?: string[] | null;
  sourceText?: string | null;
};

function normalizeGeneratedQuestions(
  generatedQuestions: Array<string | QuestionInput>,
): QuestionInput[] {
  const seen = new Set<string>();
  const normalizedQuestions: QuestionInput[] = [];

  for (const item of generatedQuestions) {
    const question = typeof item === "string" ? item : item.question;
    const normalized = question.trim().replace(/\s+/g, " ");
    const key = questionSlug(normalized);

    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedQuestions.push({
      question: normalized,
      conciseAnswer:
        typeof item === "string"
          ? ""
          : (item.conciseAnswer ?? "").trim().replace(/\s+/g, " "),
      questionProvenance:
        typeof item === "string"
          ? ""
          : (item.questionProvenance ?? "").trim().replace(/\s+/g, " "),
      proposedConceptSlugs:
        typeof item === "string" || !Array.isArray(item.proposedConceptSlugs)
          ? []
          : item.proposedConceptSlugs,
      sourceText:
        typeof item === "string"
          ? ""
          : (item.sourceText ?? "").trim().slice(0, 4_000),
    });
  }

  return normalizedQuestions;
}

export async function upsertDueQuestions(input: {
  questions: Array<string | QuestionInput>;
  sourceQuestion: string | null;
  now: number;
  deckId?: string;
  userId?: string;
}): Promise<DueQuestion[]> {
  const context = await ensureSeedData(input);
  const targetDeckId = await resolveTargetDeckId(context, input.deckId);

  const generatedQuestions = normalizeGeneratedQuestions(input.questions);

  if (generatedQuestions.length === 0) {
    return [];
  }

  const now = Math.round(input.now);

  await db
    .insert(questions)
    .values(
      generatedQuestions.map((question, index) => ({
        deckId: targetDeckId,
        question: question.question,
        questionSlug: questionSlug(question.question),
        nextDue: now + index,
        generatedFromQuestion: input.sourceQuestion,
        questionProvenance: question.questionProvenance ?? "",
        conciseAnswer: question.conciseAnswer ?? "",
        createdAt: now + index,
        updatedAt: now + index,
      })),
    )
    .onConflictDoUpdate({
      target: [questions.deckId, questions.questionSlug],
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
      generatedQuestions.map((question) => questionSlug(question.question)),
    ),
    { userId: context.userId, deckId: targetDeckId },
  );

  const dueQuestions = rows.map(toDueQuestion);

  try {
    await assignConceptSlugsForQuestions({
      userId: context.userId,
      questions: dueQuestions.map((row) => {
        const inputQuestion = generatedQuestions.find(
          (question) => questionSlug(question.question) === questionSlug(row.question),
        );

        return {
          questionId: row.questionId,
          question: row.question,
          conciseAnswer: row.conciseAnswer,
          questionProvenance: row.questionProvenance,
          sourceText: inputQuestion?.sourceText,
          proposedConceptSlugs: inputQuestion?.proposedConceptSlugs,
          fallbackSlug: row.deckName,
        };
      }),
    });
  } catch (error) {
    console.warn("[waxon] concept tag assignment failed", error);
  }

  const conceptSlugsByQuestionId = await getQuestionConceptSlugs({
    userId: context.userId,
    questionIds: dueQuestions.map((question) => question.questionId),
  });

  return dueQuestions.map((question) => ({
    ...question,
    conceptSlugs: conceptSlugsByQuestionId.get(question.questionId) ?? [],
  }));
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
  const context = await ensureSeedData(input);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        question_id: questions.id,
        deck_id: questions.deckId,
        deck_name: decks.name,
        user_id: decks.userId,
        question: questions.question,
        reviews: questions.reviews,
        next_due: questions.nextDue,
        generated_from_question: questions.generatedFromQuestion,
        question_provenance: questions.questionProvenance,
        last_answer: questions.lastAnswer,
        last_answer_summary: questions.lastAnswerSummary,
        concise_answer: questions.conciseAnswer,
        reference_answer: questions.referenceAnswer,
        flagged_at: questions.flaggedAt,
        created_at: questions.createdAt,
      })
      .from(questions)
      .innerJoin(decks, eq(decks.id, questions.deckId))
      .where(
        and(
          eq(decks.userId, context.userId),
          isNull(decks.archivedAt),
          input.questionId
            ? sql`true`
            : activeConceptEligibilityClause(context.userId),
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
    const reviews = serializeReviews(
      [
        ...previousReviews,
        {
          ts: Math.round(input.now),
          score: input.score,
        },
      ].slice(-10),
    );
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
        reviews,
        nextDue: roundedNextDue,
        lastAnswer: input.answer,
        lastAnswerSummary: input.answerSummary,
        conciseAnswer,
        updatedAt: Math.round(input.now),
      })
      .where(
        and(
          eq(questions.deckId, row.deck_id),
          eq(questions.id, row.question_id),
        ),
      );

    const [attempt] = await tx
      .insert(questionAttempts)
      .values({
        deckId: row.deck_id,
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
      deckId: row.deck_id,
      deckName: row.deck_name,
      userId: row.user_id,
      question: row.question,
      reviews,
      nextDue: roundedNextDue,
      generatedFromQuestion: row.generated_from_question || null,
      questionProvenance: row.question_provenance || null,
      lastAnswer: input.answer || null,
      lastAnswerSummary: input.answerSummary || null,
      referenceAnswer: row.reference_answer || null,
      conciseAnswer: conciseAnswer || null,
      flaggedAt: row.flagged_at,
      createdAt: row.created_at,
      conceptSlugs: [],
    };
  });
}
