import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  customType,
  index,
  integer,
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
    referenceAnswer: text("reference_answer").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    index("questions_next_due_idx").on(table.nextDue),
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
    index("question_attempts_question_submitted_idx").on(
      table.question,
      table.submittedAt.desc(),
    ),
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
    question: text("question")
      .notNull()
      .references(() => questions.question, { onDelete: "cascade" }),
    embeddingModel: text("embedding_model").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("question_embeddings_question_model_idx").on(
      table.question,
      table.embeddingModel,
    ),
    index("question_embeddings_model_question_idx").on(
      table.embeddingModel,
      table.question,
    ),
  ],
);
