import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
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
  decks,
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
import type {
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
} from "./reviewTypes";

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
  created_at: number;
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
  createdAt: number;
};

export type QuestionEmbedding = {
  question: string;
  embeddingModel: string;
  embeddingKind: string;
  sourceVersion: number;
  sourceHash: string;
  isCurrent: boolean;
  embedding: number[];
  createdAt: number;
  updatedAt: number;
};

export type QuestionWithEmbeddings = QuestionRow & {
  embeddings: QuestionEmbedding[];
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
  createdAt: number;
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
    createdAt: row.created_at,
  };
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
  return userId === "tsilva" ? slug : `${userId}:${slug}`;
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
  const rows = await db
    .select({
      id: decks.id,
      name: decks.name,
      slug: decks.slug,
      coverage: decks.coverage,
      memory: decks.memory,
      inReviewRotation: decks.inReviewRotation,
      archivedAt: decks.archivedAt,
      createdAt: decks.createdAt,
      updatedAt: decks.updatedAt,
      cardCount: sql<number>`count(distinct ${questions.id})`,
      dueCount: sql<number>`count(distinct ${questions.id}) filter (where ${questions.nextDue} <= ${now})`,
      lastReviewedAt: sql<number | null>`max(${questionAttempts.resolvedAt})`,
    })
    .from(decks)
    .leftJoin(questions, eq(questions.deckId, decks.id))
    .leftJoin(questionAttempts, eq(questionAttempts.deckId, decks.id))
    .where(and(eq(decks.userId, context.userId), isNull(decks.archivedAt)))
    .groupBy(
      decks.id,
      decks.name,
      decks.slug,
      decks.coverage,
      decks.memory,
      decks.inReviewRotation,
      decks.archivedAt,
      decks.createdAt,
      decks.updatedAt,
    )
    .orderBy(desc(decks.updatedAt), asc(decks.name));

  return rows.map(toDeckSummary);
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

export async function archiveDeck(input: {
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
    throw new Error("The current Deep Learning deck cannot be archived.");
  }

  const now = Math.round(Date.now());

  await db
    .update(decks)
    .set({
      archivedAt: now,
      inReviewRotation: false,
      updatedAt: now,
    })
    .where(and(eq(decks.id, input.deckId), eq(decks.userId, context.userId)));
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

export async function readQuestionsWithEmbeddings(input: {
  deckId?: string;
  embeddingModel?: string;
  questions?: string[];
  userId?: string;
} = {}): Promise<QuestionWithEmbeddings[]> {
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

  if (model !== null && !model) {
    throw new Error("Embedding model is required");
  }

  if (questionFilter?.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      deck_id: questions.deckId,
      question_id: questions.id,
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
      created_at: questions.createdAt,
      embedding_model: questionEmbeddings.embeddingModel,
      embedding_kind: questionEmbeddings.embeddingKind,
      source_version: questionEmbeddings.sourceVersion,
      source_hash: questionEmbeddings.sourceHash,
      is_current: questionEmbeddings.isCurrent,
      embedding: questionEmbeddings.embedding,
      embedding_created_at: questionEmbeddings.createdAt,
      embedding_updated_at: questionEmbeddings.updatedAt,
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
      ),
    )
    .where(
      and(
        eq(questions.deckId, targetDeckId),
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
    );

  const questionsByText = new Map<string, QuestionWithEmbeddings>();

  for (const row of rows) {
    const existing = questionsByText.get(row.question);
    const questionWithEmbeddings: QuestionWithEmbeddings =
      existing ??
      {
        question_id: row.question_id,
        deck_id: row.deck_id,
        deck_name: row.deck_name,
        user_id: row.user_id,
        question: row.question,
        reviews: row.reviews,
        next_due: row.next_due,
        generated_from_question: row.generated_from_question,
        question_provenance: row.question_provenance,
        last_answer: row.last_answer,
        last_answer_summary: row.last_answer_summary,
        concise_answer: row.concise_answer,
        reference_answer: row.reference_answer,
        created_at: row.created_at,
        embeddings: [],
      };

    if (!existing) {
      questionsByText.set(row.question, questionWithEmbeddings);
    }

    if (
      row.embedding_model &&
      row.embedding_kind &&
      row.embedding &&
      row.source_version !== null &&
      row.source_hash !== null &&
      row.is_current !== null &&
      row.embedding_created_at !== null &&
      row.embedding_updated_at !== null
    ) {
      questionWithEmbeddings.embeddings.push({
        question: row.question,
        embeddingModel: row.embedding_model,
        embeddingKind: row.embedding_kind,
        sourceVersion: row.source_version,
        sourceHash: row.source_hash,
        isCurrent: row.is_current,
        embedding: row.embedding,
        createdAt: row.embedding_created_at,
        updatedAt: row.embedding_updated_at,
      });
    }
  }

  return Array.from(questionsByText.values());
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
        embedding: normalizeEmbedding(item.embedding),
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
      createdAt: questionEmbeddings.createdAt,
      updatedAt: questionEmbeddings.updatedAt,
    });

  return rows.map(toQuestionEmbedding);
}

export async function getDueQuestions(
  now = Date.now(),
  input: UserContextInput = {},
): Promise<DueQuestion[]> {
  const rows = await selectQuestionRows(
    lte(questions.nextDue, Math.round(now)),
    { ...input, deckScope: "rotation" },
  );

  return rows
    .map(toDueQuestion)
    .filter((row) => Number.isFinite(row.nextDue) && row.nextDue <= now)
    .sort(
      (a, b) =>
        a.nextDue - b.nextDue ||
        a.createdAt - b.createdAt ||
        a.question.localeCompare(b.question),
    );
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
    eq(decks.inReviewRotation, true),
    input.deckId ? eq(questions.deckId, input.deckId) : sql`true`,
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
      created_at: questions.createdAt,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(Math.max(0, Math.floor(input.limit)))
    .offset(Math.max(0, Math.floor(input.offset)));

  return {
    items: rows.map(toDueQuestion).filter((row) => Number.isFinite(row.nextDue)),
    total,
  };
}

export async function getQuestionSnapshot(
  question: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const [row] = await selectQuestionRows(eq(questions.question, question), {
    ...input,
    deckScope: "all",
  });

  return row ? toDueQuestion(row) : null;
}

export async function getQuestionSnapshotById(
  questionId: string,
  input: UserContextInput = {},
): Promise<DueQuestion | null> {
  const [row] = await selectQuestionRows(eq(questions.id, questionId), {
    ...input,
    deckScope: "all",
  });

  return row ? toDueQuestion(row) : null;
}

export async function getQuestionAttempts(
  question: string,
  input: UserContextInput & { questionId?: string } = {},
): Promise<QuestionAttempt[]> {
  const context = await ensureSeedData(input);

  const rows = await db
    .select({
      id: questionAttempts.id,
      questionId: questionAttempts.questionId,
      deckId: questionAttempts.deckId,
      question: questionAttempts.question,
      rawAnswer: questionAttempts.rawAnswer,
      answerSummary: questionAttempts.answerSummary,
      score: questionAttempts.score,
      justification: questionAttempts.justification,
      submittedAt: questionAttempts.submittedAt,
      resolvedAt: questionAttempts.resolvedAt,
    })
    .from(questionAttempts)
    .where(
      and(
        inArray(
          questionAttempts.deckId,
          db
            .select({ id: decks.id })
            .from(decks)
            .where(eq(decks.userId, context.userId)),
        ),
        input.questionId
          ? eq(questionAttempts.questionId, input.questionId)
          : eq(questionAttempts.question, question),
      ),
    )
    .orderBy(asc(questionAttempts.submittedAt), asc(questionAttempts.id));

  return rows.filter(
    (attempt) =>
      Number.isFinite(attempt.id) &&
      Number.isFinite(attempt.score) &&
      Number.isFinite(attempt.submittedAt) &&
      Number.isFinite(attempt.resolvedAt),
  );
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
      ? and(eq(decks.inReviewRotation, true), isNull(decks.archivedAt))
      : input.deckScope === "all"
        ? sql`true`
        : eq(decks.id, context.deckId);

  const rows = await db
    .select({
      id: questionAttempts.id,
      questionId: questionAttempts.questionId,
      deckId: questionAttempts.deckId,
      question: questionAttempts.question,
      rawAnswer: questionAttempts.rawAnswer,
      answerSummary: questionAttempts.answerSummary,
      score: questionAttempts.score,
      justification: questionAttempts.justification,
      submittedAt: questionAttempts.submittedAt,
      resolvedAt: questionAttempts.resolvedAt,
    })
    .from(questionAttempts)
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
  nextDue: number | null;
  resolvedAt: number | null;
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
    resolvedAt: row.resolvedAt,
    nextDue: row.nextDue,
  };
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
    : and(eq(decks.inReviewRotation, true), isNull(decks.archivedAt));
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
      nextDue: answerEvaluations.nextDue,
      resolvedAt: answerEvaluations.resolvedAt,
    })
    .from(answerEvaluations)
    .innerJoin(decks, eq(decks.id, answerEvaluations.deckId))
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
      nextDue: answerEvaluations.nextDue,
      resolvedAt: answerEvaluations.resolvedAt,
    })
    .from(answerEvaluations)
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
  questionId?: string;
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
        input.questionId
          ? eq(questions.id, input.questionId)
          : eq(questions.question, input.question),
      ),
    );
}

export type QuestionInput = {
  question: string;
  conciseAnswer?: string | null;
  questionProvenance?: string | null;
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

  return rows.map(toDueQuestion);
}

export async function applyEvaluationToPostgres(input: {
  questionId?: string;
  question: string;
  answer: string;
  answerSummary: string;
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
        created_at: questions.createdAt,
      })
      .from(questions)
      .innerJoin(decks, eq(decks.id, questions.deckId))
      .where(
        and(
          eq(decks.userId, context.userId),
          eq(decks.inReviewRotation, true),
          isNull(decks.archivedAt),
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

    await tx
      .update(questions)
      .set({
        reviews,
        nextDue: roundedNextDue,
        lastAnswer: input.answer,
        lastAnswerSummary: input.answerSummary,
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
      conciseAnswer: row.concise_answer || null,
      createdAt: row.created_at,
    };
  });
}
