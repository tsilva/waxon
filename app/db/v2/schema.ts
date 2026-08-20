import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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

export const dataMigrationMarkers = waxonV2.table("data_migration_markers", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const questionLifecycle = waxonV2.enum("question_lifecycle", [
  "new",
  "learning",
  "review",
  "flagged",
  "paused",
  "archived",
  "trash",
]);
export const answerMode = waxonV2.enum("answer_mode", [
  "exact",
  "semantic",
  "rubric",
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
export const sessionStatus = waxonV2.enum("session_status", [
  "active",
  "completed",
  "abandoned",
]);
export const sessionKind = waxonV2.enum("session_kind", [
  "primary",
  "supplemental",
]);
export const sessionItemKind = waxonV2.enum("session_item_kind", [
  "base",
  "retry",
]);
export const sessionItemState = waxonV2.enum("session_item_state", [
  "queued",
  "exposed",
  "submitted",
  "evaluated",
  "invalidated",
]);
export const retryStatus = waxonV2.enum("retry_status", [
  "queued",
  "deferred",
  "cancelled",
  "waived",
  "exposed",
  "completed",
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
  dailyMinutes: integer("daily_minutes").notNull().default(10),
  desiredRetention: doublePrecision("desired_retention").notNull().default(0.9),
  newItemsPerDay: integer("new_items_per_day").notNull().default(5),
  timezone: text("timezone").notNull().default("UTC"),
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
    lifecycle: questionLifecycle("lifecycle").notNull().default("new"),
    priorLifecycle: questionLifecycle("prior_lifecycle"),
    suspensionReason: text("suspension_reason"),
    targetKey: text("target_key").notNull(),
    importance: doublePrecision("importance").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("questions_user_id_id_unique").on(table.userId, table.id),
    index("questions_user_lifecycle_idx").on(table.userId, table.lifecycle),
    index("questions_user_target_idx").on(table.userId, table.targetKey),
    uniqueIndex("questions_active_target_unique")
      .on(table.userId, table.targetKey)
      .where(
        sql`${table.lifecycle} IN ('new', 'learning', 'review')`,
      ),
  ],
);

export const questionVersions = waxonV2.table(
  "question_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    version: integer("version").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    prompt: text("prompt").notNull(),
    referenceAnswer: text("reference_answer").notNull(),
    displayAnswer: text("display_answer").notNull(),
    mode: answerMode("answer_mode").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("question_versions_user_id_id_unique").on(table.userId, table.id),
    unique("question_versions_question_version_unique").on(
      table.userId,
      table.questionId,
      table.version,
    ),
    uniqueIndex("question_versions_current_unique")
      .on(table.userId, table.questionId)
      .where(sql`${table.isCurrent} = true`),
    foreignKey({
      name: "question_versions_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    index("question_versions_current_search_idx")
      .using(
      "gin",
      sql`(
        setweight(to_tsvector('simple', coalesce(${table.prompt}, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(${table.referenceAnswer}, '')), 'B')
      )`,
      )
      .where(sql`${table.isCurrent} = true`),
    index("question_versions_current_prompt_trgm_idx")
      .using("gist", sql`${table.prompt} gist_trgm_ops`)
      .where(sql`${table.isCurrent} = true`),
  ],
);

export const questionSearchEmbeddings = waxonV2.table(
  "question_search_embeddings",
  {
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    model: text("model").notNull(),
    sourceVersion: integer("source_version").notNull(),
    sourceHash: text("source_hash").notNull(),
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
        table.sourceVersion,
      ],
    }),
    foreignKey({
      name: "question_search_embeddings_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_search_embeddings_version_fk",
      columns: [table.userId, table.questionVersionId],
      foreignColumns: [questionVersions.userId, questionVersions.id],
    }).onDelete("cascade"),
    index("question_search_embeddings_lookup_idx").on(
      table.userId,
      table.model,
      table.sourceVersion,
    ),
  ],
);

export const reviewSessions = waxonV2.table(
  "review_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: sessionKind("kind").notNull().default("primary"),
    status: sessionStatus("status").notNull().default("active"),
    timeBudgetMinutes: integer("time_budget_minutes").notNull(),
    desiredRetention: doublePrecision("desired_retention").notNull(),
    estimatedSeconds: integer("estimated_seconds").notNull().default(0),
    reservedSeconds: integer("reserved_seconds").notNull().default(0),
    plannedCount: integer("planned_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    unique("review_sessions_user_id_id_unique").on(table.userId, table.id),
    uniqueIndex("review_sessions_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const reviewSessionItems = waxonV2.table(
  "review_session_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    kind: sessionItemKind("kind").notNull().default("base"),
    position: integer("position").notNull(),
    state: sessionItemState("state").notNull().default("queued"),
    earliestAt: timestamp("earliest_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    exposedAt: timestamp("exposed_at", { withTimezone: true, mode: "date" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    estimatedSeconds: integer("estimated_seconds").notNull().default(60),
    isIntroduction: boolean("is_introduction").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    unique("review_session_items_user_id_id_unique").on(table.userId, table.id),
    unique("review_session_items_position_unique").on(
      table.userId,
      table.sessionId,
      table.position,
    ),
    foreignKey({
      name: "review_session_items_session_fk",
      columns: [table.userId, table.sessionId],
      foreignColumns: [reviewSessions.userId, reviewSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "review_session_items_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "review_session_items_version_fk",
      columns: [table.userId, table.questionVersionId],
      foreignColumns: [questionVersions.userId, questionVersions.id],
    }).onDelete("restrict"),
    index("review_session_items_next_idx").on(
      table.userId,
      table.sessionId,
      table.state,
      table.position,
    ),
  ],
);

export const answerSubmissions = waxonV2.table(
  "answer_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    sessionItemId: uuid("session_item_id").notNull(),
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
    unique("answer_submissions_item_unique").on(table.userId, table.sessionItemId),
    foreignKey({
      name: "answer_submissions_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "answer_submissions_version_fk",
      columns: [table.userId, table.questionVersionId],
      foreignColumns: [questionVersions.userId, questionVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "answer_submissions_item_fk",
      columns: [table.userId, table.sessionItemId],
      foreignColumns: [reviewSessionItems.userId, reviewSessionItems.id],
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
      name: "evaluations_submission_fk",
      columns: [table.userId, table.submissionId],
      foreignColumns: [answerSubmissions.userId, answerSubmissions.id],
    }).onDelete("cascade"),
    index("evaluations_submission_idx").on(table.userId, table.submissionId),
  ],
);

export const gradeEvents = waxonV2.table(
  "grade_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    value: grade("grade").notNull(),
    origin: gradeOrigin("origin").notNull(),
    evaluationId: uuid("evaluation_id"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("grade_events_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      name: "grade_events_submission_fk",
      columns: [table.userId, table.submissionId],
      foreignColumns: [answerSubmissions.userId, answerSubmissions.id],
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
    index("memory_states_due_idx").on(table.userId, table.dueAt),
  ],
);

export const retryObligations = waxonV2.table(
  "retry_obligations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    firstSubmissionId: uuid("first_submission_id").notNull(),
    questionId: uuid("question_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    status: retryStatus("status").notNull().default("queued"),
    earliestAt: timestamp("earliest_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("retry_obligations_submission_unique").on(
      table.userId,
      table.firstSubmissionId,
    ),
    foreignKey({
      name: "retry_obligations_submission_fk",
      columns: [table.userId, table.firstSubmissionId],
      foreignColumns: [answerSubmissions.userId, answerSubmissions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "retry_obligations_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "retry_obligations_session_fk",
      columns: [table.userId, table.sessionId],
      foreignColumns: [reviewSessions.userId, reviewSessions.id],
    }).onDelete("cascade"),
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

export const usageCounters = waxonV2.table(
  "usage_counters",
  {
    userId: text("user_id").notNull(),
    dimension: text("dimension").notNull(),
    windowStart: timestamp("window_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    used: bigint("used", { mode: "number" }).notNull().default(0),
    reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "usage_counters_pk",
      columns: [table.userId, table.dimension, table.windowStart],
    }),
  ],
);
