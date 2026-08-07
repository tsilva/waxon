CREATE TYPE "waxon_v2"."generation_run_status" AS ENUM('queued', 'preparing', 'mapping', 'matching', 'drafting', 'criticizing', 'persisting', 'ready', 'needs_attention', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "waxon_v2"."source_material_kind" AS ENUM('input', 'extracted', 'model_synthesis', 'web');--> statement-breakpoint
CREATE TYPE "waxon_v2"."target_requirement" AS ENUM('required', 'optional', 'excluded', 'unsupported');--> statement-breakpoint
CREATE TABLE "waxon_v2"."generation_run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"artifact_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_run_artifacts_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "generation_run_artifacts_run_key_unique" UNIQUE("user_id","generation_run_id","kind","artifact_key")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"workflow_run_id" text,
	"status" "waxon_v2"."generation_run_status" DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'Queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"policy_version" text NOT NULL,
	"model" text NOT NULL,
	"critic_model" text NOT NULL,
	"bank_fingerprint" text,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest" jsonb,
	"result" jsonb,
	"residuals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_runs_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"kind" "waxon_v2"."source_material_kind" NOT NULL,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"url" text,
	"model" text,
	"checksum" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_materials_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "source_materials_revision_kind_checksum_unique" UNIQUE("user_id","source_revision_id","kind","checksum")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ALTER COLUMN "auto_accept_high_confidence" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "generation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "target_key" text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "answer_rubric" text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "requirement" "waxon_v2"."target_requirement" DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD COLUMN "confidence" double precision;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evidence_spans" ADD COLUMN "source_material_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."sources" ADD COLUMN "active_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."sources" ADD COLUMN "active_run_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_questions" ADD COLUMN "relation" text DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."target_questions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."generation_run_artifacts" ADD CONSTRAINT "generation_run_artifacts_run_fk" FOREIGN KEY ("user_id","generation_run_id") REFERENCES "waxon_v2"."generation_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."generation_runs" ADD CONSTRAINT "generation_runs_source_fk" FOREIGN KEY ("user_id","source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."generation_runs" ADD CONSTRAINT "generation_runs_revision_fk" FOREIGN KEY ("user_id","source_revision_id") REFERENCES "waxon_v2"."source_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_materials" ADD CONSTRAINT "source_materials_revision_fk" FOREIGN KEY ("user_id","source_revision_id") REFERENCES "waxon_v2"."source_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_run_artifacts_run_idx" ON "waxon_v2"."generation_run_artifacts" USING btree ("user_id","generation_run_id","kind");--> statement-breakpoint
CREATE INDEX "generation_runs_source_created_idx" ON "waxon_v2"."generation_runs" USING btree ("user_id","source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_one_active_per_source" ON "waxon_v2"."generation_runs" USING btree ("user_id","source_id") WHERE "waxon_v2"."generation_runs"."status" IN ('queued','preparing','mapping','matching','drafting','criticizing','persisting');--> statement-breakpoint
CREATE INDEX "source_materials_revision_idx" ON "waxon_v2"."source_materials" USING btree ("user_id","source_revision_id");--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD CONSTRAINT "coverage_targets_revision_fk" FOREIGN KEY ("user_id","source_revision_id") REFERENCES "waxon_v2"."source_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD CONSTRAINT "coverage_targets_generation_run_fk" FOREIGN KEY ("user_id","generation_run_id") REFERENCES "waxon_v2"."generation_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evidence_spans" ADD CONSTRAINT "evidence_spans_source_material_fk" FOREIGN KEY ("user_id","source_material_id") REFERENCES "waxon_v2"."source_materials"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_targets_revision_target_key_unique" ON "waxon_v2"."coverage_targets" USING btree ("user_id","source_revision_id","target_key") WHERE "waxon_v2"."coverage_targets"."source_revision_id" IS NOT NULL AND "waxon_v2"."coverage_targets"."target_key" IS NOT NULL;
