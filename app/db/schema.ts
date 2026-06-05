import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const nowMs = sql`(extract(epoch from now()) * 1000)::bigint`;

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(3072)";
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

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    check("users_id_nonempty_check", sql`length(trim(${table.id})) > 0`),
    check(
      "users_display_name_nonempty_check",
      sql`length(trim(${table.displayName})) > 0`,
    ),
    check("users_email_nonempty_check", sql`length(trim(${table.email})) > 0`),
    check(
      "users_avatar_url_check",
      sql`${table.avatarUrl} IS NULL OR (
        length(${table.avatarUrl}) <= 700000
        AND ${table.avatarUrl} ~ '^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$'
      )`,
    ),
    check("users_created_at_check", sql`${table.createdAt} >= 0`),
    check("users_updated_at_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("auth_accounts_provider_account_idx").on(
      table.provider,
      table.providerAccountId,
    ),
    index("auth_accounts_user_id_idx").on(table.userId),
    check(
      "auth_accounts_provider_nonempty_check",
      sql`length(trim(${table.provider})) > 0`,
    ),
    check(
      "auth_accounts_provider_account_id_nonempty_check",
      sql`length(trim(${table.providerAccountId})) > 0`,
    ),
    check("auth_accounts_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "auth_accounts_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const decks = pgTable(
  "decks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    inReviewRotation: boolean("in_review_rotation").notNull().default(true),
    archivedAt: bigint("archived_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("decks_user_slug_idx").on(table.userId, table.slug),
    check("decks_id_nonempty_check", sql`length(trim(${table.id})) > 0`),
    check("decks_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
    check("decks_slug_nonempty_check", sql`length(trim(${table.slug})) > 0`),
    check("decks_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "decks_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    question: text("question").notNull(),
    questionSlug: text("question_slug").notNull(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    reviews: text("reviews").notNull().default(""),
    nextDue: bigint("next_due", { mode: "number" }).notNull().default(0),
    generatedFromQuestion: text("generated_from_question"),
    lastAnswer: text("last_answer").notNull().default(""),
    lastAnswerSummary: text("last_answer_summary").notNull().default(""),
    conciseAnswer: text("concise_answer").notNull().default(""),
    referenceAnswer: text("reference_answer").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    unique("questions_deck_id_unique").on(table.deckId, table.id),
    unique("questions_id_question_unique").on(table.id, table.question),
    unique("questions_deck_question_unique").on(table.deckId, table.question),
    uniqueIndex("questions_deck_question_slug_idx").on(
      table.deckId,
      table.questionSlug,
    ),
    index("questions_deck_next_due_idx").on(table.deckId, table.nextDue),
    foreignKey({
      name: "questions_deck_generated_from_question_fk",
      columns: [table.deckId, table.generatedFromQuestion],
      foreignColumns: [table.deckId, table.question],
    }),
    check(
      "questions_question_nonempty_check",
      sql`length(trim(${table.question})) > 0`,
    ),
    check(
      "questions_question_slug_nonempty_check",
      sql`length(trim(${table.questionSlug})) > 0`,
    ),
    check("questions_next_due_check", sql`${table.nextDue} >= 0`),
    check(
      "questions_reviews_format_check",
      sql`${table.reviews} = '' OR ${table.reviews} ~ '^[0-9]+:(10|[0-9])(\\|[0-9]+:(10|[0-9]))*$'`,
    ),
    check("questions_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "questions_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const questionAttempts = pgTable(
  "question_attempts",
  {
    id: serial("id").primaryKey(),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    rawAnswer: text("raw_answer").notNull(),
    answerSummary: text("answer_summary").notNull(),
    score: integer("score").notNull(),
    justification: text("justification").notNull(),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "question_attempts_deck_question_id_fk",
      columns: [table.deckId, table.questionId],
      foreignColumns: [questions.deckId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_attempts_question_id_question_fk",
      columns: [table.questionId, table.question],
      foreignColumns: [questions.id, questions.question],
    }).onDelete("cascade"),
    index("question_attempts_deck_question_submitted_idx").on(
      table.deckId,
      table.question,
      table.submittedAt.desc(),
    ),
    index("question_attempts_question_id_submitted_idx").on(
      table.questionId,
      table.submittedAt.desc(),
    ),
    check("question_attempts_score_check", sql`${table.score} BETWEEN 0 AND 10`),
    check(
      "question_attempts_submitted_at_check",
      sql`${table.submittedAt} >= 0`,
    ),
    check(
      "question_attempts_resolved_at_check",
      sql`${table.resolvedAt} >= ${table.submittedAt}`,
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
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
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
    foreignKey({
      name: "question_embeddings_deck_question_id_fk",
      columns: [table.deckId, table.questionId],
      foreignColumns: [questions.deckId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_embeddings_question_id_question_fk",
      columns: [table.questionId, table.question],
      foreignColumns: [questions.id, questions.question],
    }).onDelete("cascade"),
    uniqueIndex("question_embeddings_current_source_idx").on(
      table.deckId,
      table.questionId,
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
      table.questionId,
      table.embeddingModel,
      table.embeddingKind,
    ),
    index("question_embeddings_question_text_lookup_idx").on(
      table.question,
      table.embeddingModel,
      table.embeddingKind,
    ),
    check(
      "question_embeddings_model_nonempty_check",
      sql`length(trim(${table.embeddingModel})) > 0`,
    ),
    check(
      "question_embeddings_kind_nonempty_check",
      sql`length(trim(${table.embeddingKind})) > 0`,
    ),
    check("question_embeddings_source_version_check", sql`${table.sourceVersion} > 0`),
    check("question_embeddings_source_hash_check", sql`length(${table.sourceHash}) <= 128`),
    check("question_embeddings_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "question_embeddings_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const questionReviews = pgTable(
  "question_reviews",
  {
    id: serial("id").primaryKey(),
    attemptId: integer("attempt_id")
      .notNull()
      .references(() => questionAttempts.id, { onDelete: "cascade" }),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    score: integer("score").notNull(),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    unique("question_reviews_attempt_id_unique").on(table.attemptId),
    foreignKey({
      name: "question_reviews_deck_question_id_fk",
      columns: [table.deckId, table.questionId],
      foreignColumns: [questions.deckId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_reviews_question_id_question_fk",
      columns: [table.questionId, table.question],
      foreignColumns: [questions.id, questions.question],
    }).onDelete("cascade"),
    index("question_reviews_deck_question_submitted_idx").on(
      table.deckId,
      table.question,
      table.submittedAt.desc(),
    ),
    index("question_reviews_question_id_submitted_idx").on(
      table.questionId,
      table.submittedAt.desc(),
    ),
    index("question_reviews_question_id_resolved_idx").on(
      table.questionId,
      table.resolvedAt.desc(),
    ),
    check("question_reviews_score_check", sql`${table.score} BETWEEN 0 AND 10`),
    check("question_reviews_submitted_at_check", sql`${table.submittedAt} >= 0`),
    check(
      "question_reviews_resolved_at_check",
      sql`${table.resolvedAt} >= ${table.submittedAt}`,
    ),
    check("question_reviews_created_at_check", sql`${table.createdAt} >= 0`),
  ],
);
