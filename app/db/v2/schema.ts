import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
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

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(3072)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number);
  },
});

export const sourceKind = waxonV2.enum("source_kind", [
  "direct",
  "paste",
  "url",
  "pdf",
  "text",
  "topic",
]);
export const sourceStatus = waxonV2.enum("source_status", [
  "captured",
  "processing",
  "ready",
  "failed",
  "rejected_limit",
  "disabled",
  "erasing",
  "erased",
]);
export const coverageStatus = waxonV2.enum("coverage_status", [
  "covered",
  "weak",
  "missing",
  "ignored",
  "unresolved",
]);
export const questionLifecycle = waxonV2.enum("question_lifecycle", [
  "draft",
  "new",
  "learning",
  "review",
  "paused",
  "archived",
  "suspended",
  "trash",
  "superseded",
]);
export const answerMode = waxonV2.enum("answer_mode", [
  "exact",
  "semantic",
  "rubric",
]);
export const qualityDecision = waxonV2.enum("quality_decision", [
  "pending",
  "distinct",
  "duplicate",
  "uncertain",
  "rejected",
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
    .default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sources = waxonV2.table(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: sourceKind("kind").notNull(),
    status: sourceStatus("status").notNull().default("captured"),
    title: text("title").notNull(),
    originalUrl: text("original_url"),
    objectUrl: text("object_url"),
    mimeType: text("mime_type"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    checksum: text("checksum"),
    rawText: text("raw_text"),
    processingProgress: integer("processing_progress").notNull().default(0),
    error: text("error"),
    disabledAt: timestamp("disabled_at", {
      withTimezone: true,
      mode: "date",
    }),
    erasedAt: timestamp("erased_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("sources_user_id_id_unique").on(table.userId, table.id),
    index("sources_user_created_idx").on(table.userId, table.createdAt),
    index("sources_user_status_idx").on(table.userId, table.status),
    uniqueIndex("sources_user_kind_checksum_unique")
      .on(table.userId, table.kind, table.checksum)
      .where(sql`${table.kind} <> 'direct' AND ${table.checksum} IS NOT NULL`),
  ],
);

export const sourceVersions = waxonV2.table(
  "source_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    version: integer("version").notNull(),
    bodyText: text("body_text").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("source_versions_user_id_id_unique").on(table.userId, table.id),
    unique("source_versions_source_version_unique").on(
      table.userId,
      table.sourceId,
      table.version,
    ),
    foreignKey({
      name: "source_versions_source_fk",
      columns: [table.userId, table.sourceId],
      foreignColumns: [sources.userId, sources.id],
    }).onDelete("cascade"),
  ],
);

export const evidenceSpans = waxonV2.table(
  "evidence_spans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    section: text("section").notNull().default(""),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    quote: text("quote").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("evidence_spans_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      name: "evidence_spans_source_version_fk",
      columns: [table.userId, table.sourceVersionId],
      foreignColumns: [sourceVersions.userId, sourceVersions.id],
    }).onDelete("cascade"),
    index("evidence_spans_source_idx").on(table.userId, table.sourceVersionId),
    check(
      "evidence_spans_offsets_valid",
      sql`${table.startOffset} >= 0 AND ${table.endOffset} >= ${table.startOffset}`,
    ),
  ],
);

export const coverageTargets = waxonV2.table(
  "coverage_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetType: text("target_type").notNull(),
    statement: text("statement").notNull(),
    status: coverageStatus("status").notNull().default("unresolved"),
    ignoreReason: text("ignore_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("coverage_targets_user_id_id_unique").on(table.userId, table.id),
    foreignKey({
      name: "coverage_targets_source_fk",
      columns: [table.userId, table.sourceId],
      foreignColumns: [sources.userId, sources.id],
    }).onDelete("cascade"),
    index("coverage_targets_source_status_idx").on(
      table.userId,
      table.sourceId,
      table.status,
    ),
  ],
);

export const targetEvidence = waxonV2.table(
  "target_evidence",
  {
    userId: text("user_id").notNull(),
    targetId: uuid("target_id").notNull(),
    evidenceSpanId: uuid("evidence_span_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "target_evidence_pk",
      columns: [table.userId, table.targetId, table.evidenceSpanId],
    }),
    foreignKey({
      name: "target_evidence_target_fk",
      columns: [table.userId, table.targetId],
      foreignColumns: [coverageTargets.userId, coverageTargets.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "target_evidence_span_fk",
      columns: [table.userId, table.evidenceSpanId],
      foreignColumns: [evidenceSpans.userId, evidenceSpans.id],
    }).onDelete("cascade"),
  ],
);

export const questions = waxonV2.table(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lifecycle: questionLifecycle("lifecycle").notNull().default("draft"),
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
    targetText: text("target_text").notNull(),
    quality: qualityDecision("quality_decision").notNull().default("pending"),
    qualityReasons: jsonb("quality_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    duplicateOfQuestionId: uuid("duplicate_of_question_id"),
    learnerAttested: boolean("learner_attested").notNull().default(false),
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
    index("question_versions_prompt_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.prompt})`,
    ),
  ],
);

export const questionEvidence = waxonV2.table(
  "question_evidence",
  {
    userId: text("user_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    evidenceSpanId: uuid("evidence_span_id").notNull(),
    requirement: text("requirement").notNull(),
  },
  (table) => [
    primaryKey({
      name: "question_evidence_pk",
      columns: [
        table.userId,
        table.questionVersionId,
        table.evidenceSpanId,
        table.requirement,
      ],
    }),
    foreignKey({
      name: "question_evidence_version_fk",
      columns: [table.userId, table.questionVersionId],
      foreignColumns: [questionVersions.userId, questionVersions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_evidence_span_fk",
      columns: [table.userId, table.evidenceSpanId],
      foreignColumns: [evidenceSpans.userId, evidenceSpans.id],
    }).onDelete("restrict"),
  ],
);

export const targetQuestions = waxonV2.table(
  "target_questions",
  {
    userId: text("user_id").notNull(),
    targetId: uuid("target_id").notNull(),
    questionId: uuid("question_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "target_questions_pk",
      columns: [table.userId, table.targetId, table.questionId],
    }),
    foreignKey({
      name: "target_questions_target_fk",
      columns: [table.userId, table.targetId],
      foreignColumns: [coverageTargets.userId, coverageTargets.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "target_questions_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
  ],
);

export const concepts = waxonV2.table(
  "concepts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    broaderConceptId: uuid("broader_concept_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("concepts_user_id_id_unique").on(table.userId, table.id),
    unique("concepts_user_slug_unique").on(table.userId, table.slug),
    index("concepts_user_name_idx").on(table.userId, table.name),
  ],
);

export const conceptAliases = waxonV2.table(
  "concept_aliases",
  {
    userId: text("user_id").notNull(),
    conceptId: uuid("concept_id").notNull(),
    alias: text("alias").notNull(),
  },
  (table) => [
    primaryKey({
      name: "concept_aliases_pk",
      columns: [table.userId, table.alias],
    }),
    foreignKey({
      name: "concept_aliases_concept_fk",
      columns: [table.userId, table.conceptId],
      foreignColumns: [concepts.userId, concepts.id],
    }).onDelete("cascade"),
  ],
);

export const questionConcepts = waxonV2.table(
  "question_concepts",
  {
    userId: text("user_id").notNull(),
    questionId: uuid("question_id").notNull(),
    conceptId: uuid("concept_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "question_concepts_pk",
      columns: [table.userId, table.questionId, table.conceptId],
    }),
    foreignKey({
      name: "question_concepts_question_fk",
      columns: [table.userId, table.questionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_concepts_concept_fk",
      columns: [table.userId, table.conceptId],
      foreignColumns: [concepts.userId, concepts.id],
    }).onDelete("cascade"),
  ],
);

export const questionRelations = waxonV2.table(
  "question_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    fromQuestionId: uuid("from_question_id").notNull(),
    toQuestionId: uuid("to_question_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "question_relations_from_fk",
      columns: [table.userId, table.fromQuestionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "question_relations_to_fk",
      columns: [table.userId, table.toQuestionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("cascade"),
    unique("question_relations_unique").on(
      table.userId,
      table.fromQuestionId,
      table.toQuestionId,
      table.relation,
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

export const repairDrafts = waxonV2.table(
  "repair_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    parentQuestionId: uuid("parent_question_id").notNull(),
    childQuestionId: uuid("child_question_id").notNull(),
    demonstratedGap: text("demonstrated_gap").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("repair_drafts_submission_unique").on(
      table.userId,
      table.submissionId,
    ),
    foreignKey({
      name: "repair_drafts_submission_fk",
      columns: [table.userId, table.submissionId],
      foreignColumns: [answerSubmissions.userId, answerSubmissions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "repair_drafts_parent_question_fk",
      columns: [table.userId, table.parentQuestionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "repair_drafts_child_question_fk",
      columns: [table.userId, table.childQuestionId],
      foreignColumns: [questions.userId, questions.id],
    }).onDelete("restrict"),
  ],
);

export const savedViews = waxonV2.table(
  "saved_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    query: jsonb("query").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("saved_views_user_name_unique").on(table.userId, table.name),
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

export const questionEmbeddings = waxonV2.table(
  "question_embeddings",
  {
    userId: text("user_id").notNull(),
    questionVersionId: uuid("question_version_id").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "question_embeddings_pk",
      columns: [table.userId, table.questionVersionId, table.model],
    }),
    foreignKey({
      name: "question_embeddings_version_fk",
      columns: [table.userId, table.questionVersionId],
      foreignColumns: [questionVersions.userId, questionVersions.id],
    }).onDelete("cascade"),
  ],
);
