import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "@/app/db/client";
import {
  decks,
  questionAttempts,
  questionEmbeddings,
  questionReviews,
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

export type QuestionRow = {
  question_id: string;
  deck_id: string;
  deck_name: string;
  user_id: string;
  question: string;
  reviews: string;
  next_due: number;
  generated_from_question: string | null;
  last_answer: string;
  last_answer_summary: string;
  concise_answer: string;
  reference_answer: string;
  created_at: number;
};

export type DueQuestion = {
  deckId: string;
  deckName: string;
  userId: string;
  question: string;
  reviews: string;
  nextDue: number;
  generatedFromQuestion: string | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  createdAt: number;
};

export type QuestionAttempt = {
  id: number;
  deckId: string;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
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
  deckId: string;
  deckName: string;
  userId: string;
  question: string;
  reviews: string;
  nextDue: number;
  generatedFromQuestion: string | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  createdAt: number;
} | null;

export type QueuedQuestionsSortKey = "review-date" | "creation-date";

export type QueuedQuestionsPage = {
  items: DueQuestion[];
  total: number;
};

export type DeckSummary = {
  id: string;
  name: string;
  slug: string;
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
    deckId: row.deck_id,
    deckName: row.deck_name,
    userId: row.user_id,
    question: row.question,
    reviews: row.reviews,
    nextDue: row.next_due,
    generatedFromQuestion: row.generated_from_question || null,
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
    .orderBy(asc(questions.nextDue), asc(questions.question));

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
      inReviewRotation: decks.inReviewRotation,
      archivedAt: decks.archivedAt,
      createdAt: decks.createdAt,
      updatedAt: decks.updatedAt,
      cardCount: sql<number>`count(distinct ${questions.id})`,
      dueCount: sql<number>`count(distinct ${questions.id}) filter (where ${questions.nextDue} <= ${now})`,
      lastReviewedAt: sql<number | null>`max(${questionReviews.resolvedAt})`,
    })
    .from(decks)
    .leftJoin(questions, eq(questions.deckId, decks.id))
    .leftJoin(questionReviews, eq(questionReviews.deckId, decks.id))
    .where(and(eq(decks.userId, context.userId), isNull(decks.archivedAt)))
    .groupBy(
      decks.id,
      decks.name,
      decks.slug,
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
  inReviewRotation?: boolean;
  userId?: string;
}): Promise<DeckSummary> {
  const context = await ensureSeedData(input);
  const name = input.name.trim();

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

export async function getQuestionEmbedding(input: {
  question: string;
  embeddingModel: string;
  embeddingKind?: string;
  sourceVersion?: number;
  deckId?: string;
  userId?: string;
}): Promise<QuestionEmbedding | null> {
  const context = await ensureSeedData(input);
  const targetDeckId = input.deckId?.trim() || context.deckId;

  const model = normalizeEmbeddingModel(input.embeddingModel);

  if (!model) {
    throw new Error("Embedding model is required");
  }

  const [row] = await db
    .select({
      question: questionEmbeddings.question,
      embeddingModel: questionEmbeddings.embeddingModel,
      embeddingKind: questionEmbeddings.embeddingKind,
      sourceVersion: questionEmbeddings.sourceVersion,
      sourceHash: questionEmbeddings.sourceHash,
      isCurrent: questionEmbeddings.isCurrent,
      embedding: questionEmbeddings.embedding,
      createdAt: questionEmbeddings.createdAt,
      updatedAt: questionEmbeddings.updatedAt,
    })
    .from(questionEmbeddings)
    .innerJoin(questions, eq(questions.id, questionEmbeddings.questionId))
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(questions.deckId, targetDeckId),
        eq(decks.userId, context.userId),
        eq(questionEmbeddings.deckId, questions.deckId),
        eq(questionEmbeddings.question, input.question),
        eq(questionEmbeddings.embeddingModel, model),
        input.embeddingKind === undefined
          ? sql`true`
          : eq(questionEmbeddings.embeddingKind, input.embeddingKind),
        input.sourceVersion === undefined
          ? sql`true`
          : eq(questionEmbeddings.sourceVersion, input.sourceVersion),
      ),
    );

  return row ? toQuestionEmbedding(row) : null;
}

export async function upsertQuestionEmbedding(input: {
  question: string;
  embeddingModel: string;
  embeddingKind?: string;
  sourceVersion?: number;
  sourceHash?: string;
  embedding: number[];
  deckId?: string;
  now?: number;
}): Promise<QuestionEmbedding> {
  const [embedding] = await upsertQuestionEmbeddings({
    embeddings: [input],
    deckId: input.deckId,
    now: input.now,
  });

  if (!embedding) {
    throw new Error("Question embedding was not saved");
  }

  return embedding;
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
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getAllQueuedQuestions(
  input: UserContextInput = {},
): Promise<DueQuestion[]> {
  const rows = await selectQuestionRows(sql`true`, {
    ...input,
    deckScope: "rotation",
  });

  return rows
    .map(toDueQuestion)
    .filter((row) => Number.isFinite(row.nextDue))
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getQueuedQuestionsPage(
  input: UserContextInput & {
    excludeQuestions?: string[];
    limit: number;
    offset: number;
    sortKey: QueuedQuestionsSortKey;
  },
): Promise<QueuedQuestionsPage> {
  const context = await ensureSeedData(input);
  const excludeQuestions = Array.from(
    new Set(input.excludeQuestions ?? []),
  ).filter(Boolean);
  const whereClause = and(
    eq(decks.userId, context.userId),
    input.deckId
      ? eq(questions.deckId, input.deckId)
      : eq(decks.inReviewRotation, true),
    isNull(decks.archivedAt),
    excludeQuestions.length > 0
      ? notInArray(questions.question, excludeQuestions)
      : sql`true`,
  );
  const orderBy =
    input.sortKey === "creation-date"
      ? [desc(questions.createdAt), asc(questions.question)]
      : [asc(questions.nextDue), asc(questions.question)];
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

export async function getQuestionAttempts(
  question: string,
  input: UserContextInput = {},
): Promise<QuestionAttempt[]> {
  const context = await ensureSeedData(input);

  const rows = await db
    .select({
      id: questionAttempts.id,
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
        eq(questionAttempts.question, question),
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

  const rows = await db
    .select({
      id: questionAttempts.id,
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

export async function getStoredReferenceAnswer(
  question: string,
  input: UserContextInput = {},
): Promise<string | null> {
  const snapshot = await getQuestionSnapshot(question, input);
  const answer = snapshot?.referenceAnswer?.trim() ?? "";

  return answer || null;
}

export async function saveReferenceAnswer(input: {
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
        eq(questions.question, input.question),
      ),
    );
}

export type QuestionInput = {
  question: string;
  conciseAnswer?: string | null;
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
      generatedQuestions.map((question) => ({
        deckId: targetDeckId,
        question: question.question,
        questionSlug: questionSlug(question.question),
        nextDue: now,
        generatedFromQuestion: input.sourceQuestion,
        conciseAnswer: question.conciseAnswer ?? "",
        createdAt: now,
        updatedAt: now,
      })),
    )
	    .onConflictDoUpdate({
	      target: [questions.deckId, questions.questionSlug],
      set: {
        nextDue: now,
        generatedFromQuestion: sql`coalesce(
          ${questions.generatedFromQuestion},
          excluded.generated_from_question
        )`,
        conciseAnswer: sql`coalesce(nullif(${questions.conciseAnswer}, ''), excluded.concise_answer)`,
        updatedAt: now,
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
          eq(questions.question, input.question),
        ),
      )
      .for("update");

    if (!row) {
      return null;
    }

    const previousReviewRows = await tx
      .select({
        ts: questionReviews.resolvedAt,
        score: questionReviews.score,
      })
      .from(questionReviews)
      .where(eq(questionReviews.questionId, row.question_id))
      .orderBy(desc(questionReviews.resolvedAt), desc(questionReviews.id))
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
          eq(questions.question, input.question),
        ),
      );

    const [attempt] = await tx
      .insert(questionAttempts)
      .values({
        deckId: row.deck_id,
        questionId: row.question_id,
        question: input.question,
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

    await tx.insert(questionReviews).values({
      attemptId: attempt.id,
      deckId: row.deck_id,
      questionId: row.question_id,
      question: input.question,
      score: input.score,
      submittedAt: Math.round(input.submittedAt),
      resolvedAt: Math.round(input.now),
      createdAt: Math.round(input.now),
    });

    return {
      deckId: row.deck_id,
      deckName: row.deck_name,
      userId: row.user_id,
      question: row.question,
      reviews,
      nextDue: roundedNextDue,
      generatedFromQuestion: row.generated_from_question || null,
      lastAnswer: input.answer || null,
      lastAnswerSummary: input.answerSummary || null,
      referenceAnswer: row.reference_answer || null,
      conciseAnswer: row.concise_answer || null,
      createdAt: row.created_at,
    };
  });
}
