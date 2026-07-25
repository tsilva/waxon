CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA "waxon_v2";
--> statement-breakpoint
CREATE TYPE "waxon_v2"."answer_mode" AS ENUM('exact', 'semantic', 'rubric');--> statement-breakpoint
CREATE TYPE "waxon_v2"."coverage_status" AS ENUM('covered', 'weak', 'missing', 'ignored', 'unresolved');--> statement-breakpoint
CREATE TYPE "waxon_v2"."evaluation_status" AS ENUM('pending', 'complete', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "waxon_v2"."grade" AS ENUM('again', 'hard', 'good', 'easy');--> statement-breakpoint
CREATE TYPE "waxon_v2"."grade_origin" AS ENUM('deterministic', 'model', 'self', 'correction', 'invalidated');--> statement-breakpoint
CREATE TYPE "waxon_v2"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "waxon_v2"."quality_decision" AS ENUM('pending', 'distinct', 'duplicate', 'uncertain', 'rejected');--> statement-breakpoint
CREATE TYPE "waxon_v2"."question_lifecycle" AS ENUM('draft', 'new', 'learning', 'review', 'paused', 'archived', 'suspended', 'trash', 'superseded');--> statement-breakpoint
CREATE TYPE "waxon_v2"."retry_status" AS ENUM('queued', 'deferred', 'waived', 'exposed', 'completed');--> statement-breakpoint
CREATE TYPE "waxon_v2"."session_item_kind" AS ENUM('base', 'retry');--> statement-breakpoint
CREATE TYPE "waxon_v2"."session_item_state" AS ENUM('queued', 'exposed', 'submitted', 'evaluated', 'invalidated');--> statement-breakpoint
CREATE TYPE "waxon_v2"."session_kind" AS ENUM('primary', 'supplemental');--> statement-breakpoint
CREATE TYPE "waxon_v2"."session_status" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "waxon_v2"."source_kind" AS ENUM('direct', 'paste', 'url', 'pdf', 'text', 'topic');--> statement-breakpoint
CREATE TYPE "waxon_v2"."source_status" AS ENUM('captured', 'processing', 'ready', 'failed', 'rejected_limit', 'disabled', 'erasing', 'erased');--> statement-breakpoint
CREATE TYPE "waxon_v2"."submission_status" AS ENUM('pending', 'graded', 'invalidated');--> statement-breakpoint
CREATE TABLE "waxon_v2"."answer_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"session_item_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"status" "waxon_v2"."submission_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_submissions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "answer_submissions_item_unique" UNIQUE("user_id","session_item_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."concept_aliases" (
	"user_id" text NOT NULL,
	"concept_id" uuid NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "concept_aliases_pk" PRIMARY KEY("user_id","alias")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"broader_concept_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "concepts_user_slug_unique" UNIQUE("user_id","slug")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."coverage_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"statement" text NOT NULL,
	"status" "waxon_v2"."coverage_status" DEFAULT 'unresolved' NOT NULL,
	"ignore_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_targets_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"status" "waxon_v2"."evaluation_status" DEFAULT 'pending' NOT NULL,
	"evaluator" text NOT NULL,
	"proposed_grade" "waxon_v2"."grade",
	"feedback" text,
	"expected_answer" text,
	"covered_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"demonstrated_gap" text,
	"confidence" double precision,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "evaluations_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."evidence_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_spans_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "evidence_spans_offsets_valid" CHECK ("waxon_v2"."evidence_spans"."start_offset" >= 0 AND "waxon_v2"."evidence_spans"."end_offset" >= "waxon_v2"."evidence_spans"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."grade_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"grade" "waxon_v2"."grade" NOT NULL,
	"origin" "waxon_v2"."grade_origin" NOT NULL,
	"evaluation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_events_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "waxon_v2"."job_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_user_idempotency_unique" UNIQUE("user_id","type","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."learner_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"daily_minutes" integer DEFAULT 10 NOT NULL,
	"desired_retention" double precision DEFAULT 0.9 NOT NULL,
	"new_items_per_day" integer DEFAULT 5 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"auto_accept_high_confidence" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."memory_states" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_review_at" timestamp with time zone,
	"stability" double precision DEFAULT 0 NOT NULL,
	"difficulty" double precision DEFAULT 0 NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"state" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"scheduler_version" text DEFAULT 'fsrs-6' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_states_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."mutation_receipts" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_receipts_pk" PRIMARY KEY("user_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_concepts" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	CONSTRAINT "question_concepts_pk" PRIMARY KEY("user_id","question_id","concept_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_embeddings" (
	"user_id" text NOT NULL,
	"question_version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(3072) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_embeddings_pk" PRIMARY KEY("user_id","question_version_id","model")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_evidence" (
	"user_id" text NOT NULL,
	"question_version_id" uuid NOT NULL,
	"evidence_span_id" uuid NOT NULL,
	"requirement" text NOT NULL,
	CONSTRAINT "question_evidence_pk" PRIMARY KEY("user_id","question_version_id","evidence_span_id","requirement")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"from_question_id" uuid NOT NULL,
	"to_question_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_relations_unique" UNIQUE("user_id","from_question_id","to_question_id","relation")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"prompt" text NOT NULL,
	"reference_answer" text NOT NULL,
	"display_answer" text NOT NULL,
	"answer_mode" "waxon_v2"."answer_mode" NOT NULL,
	"target_text" text NOT NULL,
	"quality_decision" "waxon_v2"."quality_decision" DEFAULT 'pending' NOT NULL,
	"quality_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_of_question_id" uuid,
	"learner_attested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_versions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "question_versions_question_version_unique" UNIQUE("user_id","question_id","version")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"lifecycle" "waxon_v2"."question_lifecycle" DEFAULT 'draft' NOT NULL,
	"prior_lifecycle" "waxon_v2"."question_lifecycle",
	"suspension_reason" text,
	"target_key" text NOT NULL,
	"importance" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "questions_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."retry_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"first_submission_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" "waxon_v2"."retry_status" DEFAULT 'queued' NOT NULL,
	"earliest_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retry_obligations_submission_unique" UNIQUE("user_id","first_submission_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."review_session_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"kind" "waxon_v2"."session_item_kind" DEFAULT 'base' NOT NULL,
	"position" integer NOT NULL,
	"state" "waxon_v2"."session_item_state" DEFAULT 'queued' NOT NULL,
	"earliest_at" timestamp with time zone NOT NULL,
	"exposed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_session_items_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "review_session_items_position_unique" UNIQUE("user_id","session_id","position")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."review_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" "waxon_v2"."session_kind" DEFAULT 'primary' NOT NULL,
	"status" "waxon_v2"."session_status" DEFAULT 'active' NOT NULL,
	"time_budget_minutes" integer NOT NULL,
	"desired_retention" double precision NOT NULL,
	"estimated_seconds" integer DEFAULT 0 NOT NULL,
	"planned_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "review_sessions_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_text" text NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_versions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "source_versions_source_version_unique" UNIQUE("user_id","source_id","version")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" "waxon_v2"."source_kind" NOT NULL,
	"status" "waxon_v2"."source_status" DEFAULT 'captured' NOT NULL,
	"title" text NOT NULL,
	"original_url" text,
	"object_url" text,
	"mime_type" text,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"checksum" text,
	"raw_text" text,
	"processing_progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"disabled_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."target_evidence" (
	"user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"evidence_span_id" uuid NOT NULL,
	CONSTRAINT "target_evidence_pk" PRIMARY KEY("user_id","target_id","evidence_span_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."target_questions" (
	"user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	CONSTRAINT "target_questions_pk" PRIMARY KEY("user_id","target_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."usage_counters" (
	"user_id" text NOT NULL,
	"dimension" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_pk" PRIMARY KEY("user_id","dimension","window_start")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_nonempty" CHECK (length(trim("waxon_v2"."users"."id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" ADD CONSTRAINT "answer_submissions_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" ADD CONSTRAINT "answer_submissions_version_fk" FOREIGN KEY ("user_id","question_version_id") REFERENCES "waxon_v2"."question_versions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" ADD CONSTRAINT "answer_submissions_item_fk" FOREIGN KEY ("user_id","session_item_id") REFERENCES "waxon_v2"."review_session_items"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."concept_aliases" ADD CONSTRAINT "concept_aliases_concept_fk" FOREIGN KEY ("user_id","concept_id") REFERENCES "waxon_v2"."concepts"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."concepts" ADD CONSTRAINT "concepts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD CONSTRAINT "coverage_targets_source_fk" FOREIGN KEY ("user_id","source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD CONSTRAINT "evaluations_submission_fk" FOREIGN KEY ("user_id","submission_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evidence_spans" ADD CONSTRAINT "evidence_spans_source_version_fk" FOREIGN KEY ("user_id","source_version_id") REFERENCES "waxon_v2"."source_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD CONSTRAINT "grade_events_submission_fk" FOREIGN KEY ("user_id","submission_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ADD CONSTRAINT "learner_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ADD CONSTRAINT "memory_states_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."mutation_receipts" ADD CONSTRAINT "mutation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_concepts" ADD CONSTRAINT "question_concepts_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_concepts" ADD CONSTRAINT "question_concepts_concept_fk" FOREIGN KEY ("user_id","concept_id") REFERENCES "waxon_v2"."concepts"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" ADD CONSTRAINT "question_embeddings_version_fk" FOREIGN KEY ("user_id","question_version_id") REFERENCES "waxon_v2"."question_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ADD CONSTRAINT "question_evidence_version_fk" FOREIGN KEY ("user_id","question_version_id") REFERENCES "waxon_v2"."question_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ADD CONSTRAINT "question_evidence_span_fk" FOREIGN KEY ("user_id","evidence_span_id") REFERENCES "waxon_v2"."evidence_spans"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_relations" ADD CONSTRAINT "question_relations_from_fk" FOREIGN KEY ("user_id","from_question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_relations" ADD CONSTRAINT "question_relations_to_fk" FOREIGN KEY ("user_id","to_question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_versions" ADD CONSTRAINT "question_versions_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."retry_obligations" ADD CONSTRAINT "retry_obligations_submission_fk" FOREIGN KEY ("user_id","first_submission_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."retry_obligations" ADD CONSTRAINT "retry_obligations_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."retry_obligations" ADD CONSTRAINT "retry_obligations_session_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "waxon_v2"."review_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" ADD CONSTRAINT "review_session_items_session_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "waxon_v2"."review_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" ADD CONSTRAINT "review_session_items_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" ADD CONSTRAINT "review_session_items_version_fk" FOREIGN KEY ("user_id","question_version_id") REFERENCES "waxon_v2"."question_versions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_sessions" ADD CONSTRAINT "review_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_versions" ADD CONSTRAINT "source_versions_source_fk" FOREIGN KEY ("user_id","source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."sources" ADD CONSTRAINT "sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_evidence" ADD CONSTRAINT "target_evidence_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "waxon_v2"."coverage_targets"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_evidence" ADD CONSTRAINT "target_evidence_span_fk" FOREIGN KEY ("user_id","evidence_span_id") REFERENCES "waxon_v2"."evidence_spans"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_questions" ADD CONSTRAINT "target_questions_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "waxon_v2"."coverage_targets"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_questions" ADD CONSTRAINT "target_questions_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_submissions_pending_question_idx" ON "waxon_v2"."answer_submissions" USING btree ("user_id","question_id","status");--> statement-breakpoint
CREATE INDEX "concepts_user_name_idx" ON "waxon_v2"."concepts" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "coverage_targets_source_status_idx" ON "waxon_v2"."coverage_targets" USING btree ("user_id","source_id","status");--> statement-breakpoint
CREATE INDEX "evaluations_submission_idx" ON "waxon_v2"."evaluations" USING btree ("user_id","submission_id");--> statement-breakpoint
CREATE INDEX "evidence_spans_source_idx" ON "waxon_v2"."evidence_spans" USING btree ("user_id","source_version_id");--> statement-breakpoint
CREATE INDEX "grade_events_submission_created_idx" ON "waxon_v2"."grade_events" USING btree ("user_id","submission_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "waxon_v2"."jobs" USING btree ("status","priority","run_after","created_at");--> statement-breakpoint
CREATE INDEX "memory_states_due_idx" ON "waxon_v2"."memory_states" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_current_unique" ON "waxon_v2"."question_versions" USING btree ("user_id","question_id") WHERE "waxon_v2"."question_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "question_versions_prompt_search_idx" ON "waxon_v2"."question_versions" USING gin (to_tsvector('simple', "prompt"));--> statement-breakpoint
CREATE INDEX "questions_user_lifecycle_idx" ON "waxon_v2"."questions" USING btree ("user_id","lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_active_target_unique" ON "waxon_v2"."questions" USING btree ("user_id","target_key") WHERE "waxon_v2"."questions"."lifecycle" IN ('new', 'learning', 'review');--> statement-breakpoint
CREATE INDEX "review_session_items_next_idx" ON "waxon_v2"."review_session_items" USING btree ("user_id","session_id","state","position");--> statement-breakpoint
CREATE UNIQUE INDEX "review_sessions_one_active_per_user" ON "waxon_v2"."review_sessions" USING btree ("user_id") WHERE "waxon_v2"."review_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sources_user_created_idx" ON "waxon_v2"."sources" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sources_user_status_idx" ON "waxon_v2"."sources" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "waxon_v2"."users" USING btree ("email");
