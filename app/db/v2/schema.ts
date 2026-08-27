import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  halfvec,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const waxonV2 = pgSchema("waxon_v2");

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

export const questionLifecycle = waxonV2.enum("question_lifecycle", [
  "active",
  "flagged",
  "archived",
]);
export const questionFlagOrigin = waxonV2.enum("question_flag_origin", [
  "waxon_validation",
  "learner",
]);
export const grade = waxonV2.enum("grade", [
  "again",
  "hard",
  "good",
  "easy",
]);
export const gradeOrigin = waxonV2.enum("grade_origin", [
  "deterministic",
  "model",
  "self",
  "correction",
  "invalidated",
]);
export const submissionStatus = waxonV2.enum("submission_status", [
  "pending",
  "graded",
  "invalidated",
]);
export const evaluationStatus = waxonV2.enum("evaluation_status", [
  "pending",
  "complete",
  "failed",
  "superseded",
]);
export const jobStatus = waxonV2.enum("job_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const users = waxonV2.table(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("users_id_nonempty", sql`length(trim(${table.id})) > 0`),
    index("users_email_idx").on(table.email),
  ],
);

export const learnerSettings = waxonV2.table("learner_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  timezone: text("timezone"),
  autoAcceptHighConfidence: boolean("auto_accept_high_confidence")
    .notNull()
    .default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mcpCredentials = waxonV2.table(
  "mcp_credentials",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    unique("mcp_credentials_token_hash_unique").on(table.tokenHash),
    index("mcp_credentials_active_token_idx")
      .on(table.tokenHash)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const llmTraceInteractions = waxonV2.table(
  "llm_trace_interactions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    calls: text("calls").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("v2_llm_trace_interactions_started_at_idx").on(
      table.startedAt.desc(),
    ),
  ],
);

export const questions = waxonV2.table(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    referenceAnswer: text("reference_answer").notNull(),
    lifecycle: questionLifecycle("lifecycle").notNull().default("active"),
    targetKey: text("target_key").notNull(),
    creationOrder: bigserial("creation_order", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("questions_user_id_id_unique").on(table.userId, table.id),
    index("questions_user_lifecycle_idx").on(table.userId, table.lifecycle),
    index("questions_user_target_idx").on(table.userId, table.targetKey),
    uniqueIndex("questions_active_target_unique")
      .on(table.userId, table.targetKey)
      .where(sql`${table.lifecycle} = 'active'`),
    index("questions_search_idx").using(
      "gin",
      sql`(
        setweight(to_tsvector('simple', coalesce(${table.prompt}, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(${table.referenceAnswer}, '')), 'B')
      )`,
    ),
    index("questions_prompt_trgm_idx").using(
      "gist",
      sql`${table.prompt} gist_trgm_ops`,
    ),
  ],
);

export const questionFlags = waxonV2.table(
  "question_flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    origin: questionFlagOrigin("origin").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    detail: text("detail"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "question_flags_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    index("question_flags_question_created_idx").on(
      table.userId,
      table.questionId,
      table.createdAt,
    ),
    index("question_flags_unresolved_idx")
      .on(table.userId, table.questionId)
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export const questionSearchEmbeddings = waxonV2.table(
  "question_search_embeddings",
  {
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    model: text("model").notNull(),
    embeddingVersion: integer("embedding_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    embedding: halfvec("embedding", { dimensions: 512 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "question_search_embeddings_pk",
      columns: [
        table.userId,
        table.questionId,
        table.model,
        table.embeddingVersion,
      ],
    }),
    foreignKey({
      name: "question_search_embeddings_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    index("question_search_embeddings_lookup_idx").on(
      table.userId,
      table.model,
      table.embeddingVersion,
    ),
  ],
);

export const answerSubmissions = waxonV2.table(
  "answer_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    answer: text("answer").notNull(),
    status: submissionStatus("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("answer_submissions_user_id_id_unique").on(table.userId, table.id),
    unique("answer_submissions_user_id_id_question_id_unique").on(
      table.userId,
      table.id,
      table.questionId,
    ),
    foreignKey({
      name: "answer_submissions_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    index("answer_submissions_pending_question_idx").on(
      table.userId,
      table.questionId,
      table.status,
    ),
  ],
);

export const evaluations = waxonV2.table(
  "evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    status: evaluationStatus("status").notNull().default("pending"),
    evaluator: text("evaluator").notNull(),
    proposedGrade: grade("proposed_grade"),
    feedback: text("feedback"),
    expectedAnswer: text("expected_answer"),
    coveredPoints: jsonb("covered_points").$type<string[]>().notNull().default([]),
    missingPoints: jsonb("missing_points").$type<string[]>().notNull().default([]),
    demonstratedGap: text("demonstrated_gap"),
    confidence: doublePrecision("confidence"),
    error: text("error"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    unique("evaluations_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      name: "evaluations_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "evaluations_submission_question_fk",
      columns: [table.userId, table.submissionId, table.questionId],
      foreignColumns: [
        answerSubmissions.userId,
        answerSubmissions.id,
        answerSubmissions.questionId,
      ],
    }).onDelete("cascade"),
    index("evaluations_submission_idx").on(table.userId, table.submissionId),
  ],
);

export const gradeEvents = waxonV2.table(
  "grade_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    value: grade("grade").notNull(),
    origin: gradeOrigin("origin").notNull(),
    evaluationId: uuid("evaluation_id"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("grade_events_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      name: "grade_events_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "grade_events_submission_question_fk",
      columns: [table.userId, table.submissionId, table.questionId],
      foreignColumns: [
        answerSubmissions.userId,
        answerSubmissions.id,
        answerSubmissions.questionId,
      ],
    }).onDelete("cascade"),
    index("grade_events_submission_created_idx").on(
      table.userId,
      table.submissionId,
      table.createdAt,
    ),
  ],
);

export const memoryStates = waxonV2.table(
  "memory_states",
  {
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    lastReviewAt: timestamp("last_review_at", {
      withTimezone: true,
      mode: "date",
    }),
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    state: integer("state").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    schedulerVersion: text("scheduler_version").notNull().default("fsrs-6"),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "memory_states_pk",
      columns: [table.userId, table.questionId],
    }),
    foreignKey({
      name: "memory_states_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    index("memory_states_due_idx").on(table.userId, table.dueOn),
  ],
);

export const jobs = waxonV2.table(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: jobStatus("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(2),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    progress: integer("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lockedUntil: timestamp("locked_until", {
      withTimezone: true,
      mode: "date",
    }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("jobs_user_idempotency_unique").on(
      table.userId,
      table.type,
      table.idempotencyKey,
    ),
    index("jobs_claim_idx").on(
      table.status,
      table.priority,
      table.runAfter,
      table.createdAt,
    ),
  ],
);

export const mutationReceipts = waxonV2.table(
  "mutation_receipts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "mutation_receipts_pk",
      columns: [table.userId, table.scope, table.key],
    }),
  ],
);
