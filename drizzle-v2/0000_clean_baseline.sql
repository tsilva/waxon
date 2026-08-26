CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE SCHEMA "waxon_v2";
--> statement-breakpoint
CREATE TYPE "waxon_v2"."evaluation_status" AS ENUM('pending', 'complete', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "waxon_v2"."grade" AS ENUM('again', 'hard', 'good', 'easy');--> statement-breakpoint
CREATE TYPE "waxon_v2"."grade_origin" AS ENUM('deterministic', 'model', 'self', 'correction', 'invalidated');--> statement-breakpoint
CREATE TYPE "waxon_v2"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "waxon_v2"."question_flag_origin" AS ENUM('waxon_validation', 'learner');--> statement-breakpoint
CREATE TYPE "waxon_v2"."question_lifecycle" AS ENUM('active', 'flagged', 'archived');--> statement-breakpoint
CREATE TYPE "waxon_v2"."submission_status" AS ENUM('pending', 'graded', 'invalidated');--> statement-breakpoint
CREATE TABLE "waxon_v2"."answer_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"status" "waxon_v2"."submission_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_submissions_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "answer_submissions_user_id_id_question_id_unique" UNIQUE("user_id","id","question_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
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
CREATE TABLE "waxon_v2"."grade_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
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
	"timezone" text,
	"auto_accept_high_confidence" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."llm_trace_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" bigint NOT NULL,
	"status" text NOT NULL,
	"calls" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."mcp_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."memory_states" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"due_on" date NOT NULL,
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
CREATE TABLE "waxon_v2"."question_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"origin" "waxon_v2"."question_flag_origin" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_search_embeddings" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding_version" integer NOT NULL,
	"prompt_hash" text NOT NULL,
	"embedding" halfvec(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_search_embeddings_pk" PRIMARY KEY("user_id","question_id","model","embedding_version")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"reference_answer" text NOT NULL,
	"lifecycle" "waxon_v2"."question_lifecycle" DEFAULT 'active' NOT NULL,
	"target_key" text NOT NULL,
	"creation_order" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_user_id_id_unique" UNIQUE("user_id","id")
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
ALTER TABLE "waxon_v2"."evaluations" ADD CONSTRAINT "evaluations_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD CONSTRAINT "evaluations_submission_question_fk" FOREIGN KEY ("user_id","submission_id","question_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id","question_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD CONSTRAINT "grade_events_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD CONSTRAINT "grade_events_submission_question_fk" FOREIGN KEY ("user_id","submission_id","question_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id","question_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ADD CONSTRAINT "learner_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."mcp_credentials" ADD CONSTRAINT "mcp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ADD CONSTRAINT "memory_states_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."mutation_receipts" ADD CONSTRAINT "mutation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_flags" ADD CONSTRAINT "question_flags_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_search_embeddings" ADD CONSTRAINT "question_search_embeddings_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_submissions_pending_question_idx" ON "waxon_v2"."answer_submissions" USING btree ("user_id","question_id","status");--> statement-breakpoint
CREATE INDEX "evaluations_submission_idx" ON "waxon_v2"."evaluations" USING btree ("user_id","submission_id");--> statement-breakpoint
CREATE INDEX "grade_events_submission_created_idx" ON "waxon_v2"."grade_events" USING btree ("user_id","submission_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "waxon_v2"."jobs" USING btree ("status","priority","run_after","created_at");--> statement-breakpoint
CREATE INDEX "v2_llm_trace_interactions_started_at_idx" ON "waxon_v2"."llm_trace_interactions" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_credentials_active_token_idx" ON "waxon_v2"."mcp_credentials" USING btree ("token_hash") WHERE "waxon_v2"."mcp_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "memory_states_due_idx" ON "waxon_v2"."memory_states" USING btree ("user_id","due_on");--> statement-breakpoint
CREATE INDEX "question_flags_question_created_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id","created_at");--> statement-breakpoint
CREATE INDEX "question_flags_unresolved_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id") WHERE "waxon_v2"."question_flags"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "question_search_embeddings_lookup_idx" ON "waxon_v2"."question_search_embeddings" USING btree ("user_id","model","embedding_version");--> statement-breakpoint
CREATE INDEX "questions_user_lifecycle_idx" ON "waxon_v2"."questions" USING btree ("user_id","lifecycle");--> statement-breakpoint
CREATE INDEX "questions_user_target_idx" ON "waxon_v2"."questions" USING btree ("user_id","target_key");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_active_target_unique" ON "waxon_v2"."questions" USING btree ("user_id","target_key") WHERE "waxon_v2"."questions"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "questions_search_idx" ON "waxon_v2"."questions" USING gin ((
        setweight(to_tsvector('simple', coalesce("prompt", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("reference_answer", '')), 'B')
      ));--> statement-breakpoint
CREATE INDEX "questions_prompt_trgm_idx" ON "waxon_v2"."questions" USING gist ("prompt" gist_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "waxon_v2"."users" USING btree ("email");
