import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const nowMs = sql`(extract(epoch from now()) * 1000)::bigint`;

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map((component) => Number.parseFloat(component));
  },
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
});

export const decks = pgTable(
  "decks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [uniqueIndex("decks_user_slug_idx").on(table.userId, table.slug)],
);

export const questions = pgTable(
  "questions",
  {
    question: text("question").primaryKey(),
    questionSlug: text("question_slug").notNull(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    reviews: text("reviews").notNull().default(""),
    nextDue: bigint("next_due", { mode: "number" }).notNull().default(0),
    generatedFromQuestion: text("generated_from_question").references(
      (): AnyPgColumn => questions.question,
      { onDelete: "set null" },
    ),
    lastAnswer: text("last_answer").notNull().default(""),
    lastAnswerSummary: text("last_answer_summary").notNull().default(""),
    conciseAnswer: text("concise_answer").notNull().default(""),
    referenceAnswer: text("reference_answer").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("questions_question_slug_idx").on(table.questionSlug),
    index("questions_deck_next_due_idx").on(table.deckId, table.nextDue),
  ],
);

export const questionAttempts = pgTable(
  "question_attempts",
  {
    id: serial("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    question: text("question")
      .notNull()
      .references(() => questions.question, { onDelete: "cascade" }),
    rawAnswer: text("raw_answer").notNull(),
    answerSummary: text("answer_summary").notNull(),
    score: integer("score").notNull(),
    justification: text("justification").notNull(),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("question_attempts_deck_question_submitted_idx").on(
      table.deckId,
      table.question,
      table.submittedAt.desc(),
    ),
  ],
);

export const questionEmbeddings = pgTable(
  "question_embeddings",
  {
    id: serial("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    question: text("question")
      .notNull()
      .references(() => questions.question, { onDelete: "cascade" }),
    embeddingModel: text("embedding_model").notNull(),
    embeddingKind: text("embedding_kind").notNull().default("question_only"),
    sourceVersion: integer("source_version").notNull().default(1),
    sourceHash: text("source_hash").notNull().default(""),
    isCurrent: boolean("is_current").notNull().default(true),
    embedding: vector("embedding").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("question_embeddings_current_source_idx").on(
      table.deckId,
      table.question,
      table.embeddingModel,
      table.embeddingKind,
      table.sourceVersion,
    ),
    index("question_embeddings_lookup_idx").on(
      table.deckId,
      table.embeddingModel,
      table.embeddingKind,
      table.sourceVersion,
      table.isCurrent,
    ),
    index("question_embeddings_question_lookup_idx").on(
      table.question,
      table.embeddingModel,
      table.embeddingKind,
    ),
  ],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: serial("id").primaryKey(),
    operation: text("operation").notNull(),
    provider: text("provider").notNull().default("openrouter"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    deckId: text("deck_id").references(() => decks.id, { onDelete: "set null" }),
    question: text("question"),
    requestedModel: text("requested_model").notNull(),
    returnedModel: text("returned_model"),
    generationId: text("generation_id"),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    cost: numeric("cost", { mode: "number" }),
    latencyMs: integer("latency_ms").notNull(),
    usage: jsonb("usage").$type<Record<string, unknown> | null>(),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("llm_calls_generation_idx").on(table.generationId),
    index("llm_calls_user_created_idx").on(table.userId, table.createdAt),
    index("llm_calls_deck_created_idx").on(table.deckId, table.createdAt),
    index("llm_calls_operation_created_idx").on(
      table.operation,
      table.createdAt,
    ),
  ],
);
