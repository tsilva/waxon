import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
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

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    questionSlug: text("question_slug").notNull(),
    reviews: text("reviews").notNull().default(""),
    nextDue: bigint("next_due", { mode: "number" }).notNull().default(0),
    generatedFromQuestion: text("generated_from_question"),
    questionProvenance: text("question_provenance").notNull().default(""),
    lastAnswer: text("last_answer").notNull().default(""),
    lastAnswerSummary: text("last_answer_summary").notNull().default(""),
    conciseAnswer: text("concise_answer").notNull().default(""),
    referenceAnswer: text("reference_answer").notNull().default(""),
    flaggedAt: bigint("flagged_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("questions_user_question_slug_idx").on(
      table.userId,
      table.questionSlug,
    ),
    unique("questions_id_question_unique").on(table.id, table.question),
    uniqueIndex("questions_user_question_idx").on(table.userId, table.question),
    index("questions_user_next_due_idx").on(table.userId, table.nextDue),
    index("questions_active_user_due_idx")
      .on(table.userId, table.nextDue, table.createdAt, table.question)
      .where(sql`${table.flaggedAt} IS NULL`),
    index("questions_active_user_created_idx")
      .on(table.userId, table.createdAt.desc(), table.question)
      .where(sql`${table.flaggedAt} IS NULL`),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    index("question_attempts_user_question_submitted_idx").on(
      table.userId,
      table.question,
      table.submittedAt.desc(),
    ),
    index("question_attempts_user_submitted_idx").on(
      table.userId,
      table.submittedAt.desc(),
      table.id.desc(),
    ),
    index("question_attempts_user_resolved_idx").on(
      table.userId,
      table.resolvedAt.desc(),
      table.id.desc(),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    projectionX: doublePrecision("projection_x"),
    projectionY: doublePrecision("projection_y"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("question_embeddings_current_source_idx").on(
      table.userId,
      table.questionId,
      table.embeddingModel,
      table.embeddingKind,
      table.sourceVersion,
    ),
    index("question_embeddings_lookup_idx").on(
      table.userId,
      table.embeddingModel,
      table.embeddingKind,
      table.sourceVersion,
      table.isCurrent,
    ),
    index("question_embeddings_current_nonempty_lookup_idx")
      .on(
        table.userId,
        table.embeddingModel,
        table.embeddingKind,
        table.sourceVersion,
      )
      .where(sql`${table.isCurrent} = true AND ${table.sourceHash} <> ''`),
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
    check(
      "question_embeddings_projection_pair_check",
      sql`(
        ${table.projectionX} IS NULL AND ${table.projectionY} IS NULL
      ) OR (
        ${table.projectionX} IS NOT NULL
        AND ${table.projectionY} IS NOT NULL
        AND ${table.projectionX}::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND ${table.projectionY}::text NOT IN ('NaN', 'Infinity', '-Infinity')
      )`,
    ),
    check("question_embeddings_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "question_embeddings_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const conceptTags = pgTable(
  "concept_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    active: boolean("active").notNull().default(true),
    embedding: vector("embedding"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("concept_tags_user_slug_idx").on(table.userId, table.slug),
    index("concept_tags_user_active_idx").on(table.userId, table.active),
    check("concept_tags_slug_nonempty_check", sql`length(trim(${table.slug})) > 0`),
    check(
      "concept_tags_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check("concept_tags_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "concept_tags_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const questionConceptTags = pgTable(
  "question_concept_tags",
  {
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    conceptTagId: uuid("concept_tag_id")
      .notNull()
      .references(() => conceptTags.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    primaryKey({
      name: "question_concept_tags_pkey",
      columns: [table.questionId, table.conceptTagId],
    }),
    index("question_concept_tags_tag_question_idx").on(
      table.conceptTagId,
      table.questionId,
    ),
    check(
      "question_concept_tags_created_at_check",
      sql`${table.createdAt} >= 0`,
    ),
  ],
);

export const courses = pgTable(
  "courses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topicPrompt: text("topic_prompt").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    toc: jsonb("toc").notNull(),
    status: text("status").notNull().default("active"),
    currentChapterIndex: integer("current_chapter_index").notNull().default(0),
    currentPageIndex: integer("current_page_index").notNull().default(0),
    conversationCost: doublePrecision("conversation_cost").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    index("courses_user_status_updated_idx").on(
      table.userId,
      table.status,
      table.updatedAt.desc(),
    ),
    check("courses_topic_prompt_nonempty_check", sql`length(trim(${table.topicPrompt})) > 0`),
    check("courses_title_nonempty_check", sql`length(trim(${table.title})) > 0`),
    check(
      "courses_status_check",
      sql`${table.status} IN ('active', 'completed')`,
    ),
    check("courses_current_chapter_index_check", sql`${table.currentChapterIndex} >= 0`),
    check("courses_current_page_index_check", sql`${table.currentPageIndex} >= 0`),
    check("courses_conversation_cost_check", sql`${table.conversationCost} >= 0`),
    check("courses_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "courses_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const courseChatMessages = pgTable(
  "course_chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").notNull().default(sql`'[]'::jsonb`),
    sequence: integer("sequence").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("course_chat_messages_course_sequence_idx").on(
      table.courseId,
      table.sequence,
    ),
    index("course_chat_messages_course_created_idx").on(
      table.courseId,
      table.createdAt,
    ),
    check(
      "course_chat_messages_role_check",
      sql`${table.role} IN ('assistant', 'user')`,
    ),
    check(
      "course_chat_messages_content_nonempty_check",
      sql`length(trim(${table.content})) > 0`,
    ),
    check("course_chat_messages_sequence_check", sql`${table.sequence} >= 0`),
    check("course_chat_messages_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "course_chat_messages_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const coursePages = pgTable(
  "course_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").references(() => questions.id, {
      onDelete: "set null",
    }),
    chapterIndex: integer("chapter_index").notNull(),
    pageIndex: integer("page_index").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    summary: text("summary").notNull(),
    question: text("question").notNull(),
    choices: jsonb("choices").notNull(),
    correctChoiceId: text("correct_choice_id").notNull(),
    correctAnswer: text("correct_answer").notNull(),
    explanation: text("explanation").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex("course_pages_course_position_idx").on(
      table.courseId,
      table.chapterIndex,
      table.pageIndex,
    ),
    index("course_pages_question_id_idx").on(table.questionId),
    check("course_pages_chapter_index_check", sql`${table.chapterIndex} >= 0`),
    check("course_pages_page_index_check", sql`${table.pageIndex} >= 0`),
    check("course_pages_title_nonempty_check", sql`length(trim(${table.title})) > 0`),
    check("course_pages_body_nonempty_check", sql`length(trim(${table.body})) > 0`),
    check("course_pages_summary_nonempty_check", sql`length(trim(${table.summary})) > 0`),
    check("course_pages_question_nonempty_check", sql`length(trim(${table.question})) > 0`),
    check(
      "course_pages_correct_choice_id_nonempty_check",
      sql`length(trim(${table.correctChoiceId})) > 0`,
    ),
    check(
      "course_pages_correct_answer_nonempty_check",
      sql`length(trim(${table.correctAnswer})) > 0`,
    ),
    check("course_pages_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "course_pages_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const coursePageAttempts = pgTable(
  "course_page_attempts",
  {
    id: serial("id").primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => coursePages.id, { onDelete: "cascade" }),
    selectedChoiceId: text("selected_choice_id").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    feedback: text("feedback").notNull().default(""),
    attemptedAt: bigint("attempted_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("course_page_attempts_course_page_idx").on(
      table.courseId,
      table.pageId,
      table.attemptedAt.desc(),
    ),
    check(
      "course_page_attempts_selected_choice_id_nonempty_check",
      sql`length(trim(${table.selectedChoiceId})) > 0`,
    ),
    check("course_page_attempts_attempted_at_check", sql`${table.attemptedAt} >= 0`),
  ],
);

export const answerEvaluations = pgTable(
  "answer_evaluations",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => llmTraceInteractions.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    rawAnswer: text("raw_answer").notNull(),
    status: text("status").notNull(),
    phase: text("phase"),
    lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
    score: integer("score"),
    justification: text("justification"),
    answerSummary: text("answer_summary"),
    nextDue: bigint("next_due", { mode: "number" }),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    index("answer_evaluations_user_status_submitted_idx").on(
      table.userId,
      table.status,
      table.submittedAt.desc(),
    ),
    index("answer_evaluations_trace_id_idx").on(table.traceId),
    check("answer_evaluations_id_nonempty_check", sql`length(trim(${table.id})) > 0`),
    check(
      "answer_evaluations_trace_id_nonempty_check",
      sql`length(trim(${table.traceId})) > 0`,
    ),
    check(
      "answer_evaluations_question_nonempty_check",
      sql`length(trim(${table.question})) > 0`,
    ),
    check(
      "answer_evaluations_status_check",
      sql`${table.status} IN ('grading', 'resolved')`,
    ),
    check(
      "answer_evaluations_phase_check",
      sql`${table.phase} IS NULL OR ${table.phase} IN (
        'queued',
        'evaluating-answer',
        'saving-evaluation',
        'finalizing'
      )`,
    ),
    check(
      "answer_evaluations_score_check",
      sql`${table.score} IS NULL OR ${table.score} BETWEEN 0 AND 10`,
    ),
    check(
      "answer_evaluations_last_activity_at_check",
      sql`${table.lastActivityAt} >= 0`,
    ),
    check(
      "answer_evaluations_submitted_at_check",
      sql`${table.submittedAt} >= 0`,
    ),
    check(
      "answer_evaluations_resolved_at_check",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.submittedAt}`,
    ),
    check("answer_evaluations_created_at_check", sql`${table.createdAt} >= 0`),
    check(
      "answer_evaluations_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const llmTraceInteractions = pgTable(
  "llm_trace_interactions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    calls: text("calls").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(nowMs),
  },
  (table) => [
    index("llm_trace_interactions_started_at_idx").on(table.startedAt.desc()),
    check(
      "llm_trace_interactions_id_nonempty_check",
      sql`length(trim(${table.id})) > 0`,
    ),
    check(
      "llm_trace_interactions_title_nonempty_check",
      sql`length(trim(${table.title})) > 0`,
    ),
    check(
      "llm_trace_interactions_kind_check",
      sql`${table.kind} IN (
        'Answer evaluation',
        'Question generation',
        'Reference answer',
        'Embedding',
        'Knowledge memory',
        'Quality gate',
        'Summarization',
        'Other'
      )`,
    ),
    check(
      "llm_trace_interactions_status_check",
      sql`${table.status} IN ('ok', 'pending', 'error')`,
    ),
    check(
      "llm_trace_interactions_started_at_check",
      sql`${table.startedAt} >= 0`,
    ),
    check(
      "llm_trace_interactions_updated_at_check",
      sql`${table.updatedAt} >= ${table.startedAt}`,
    ),
  ],
);
