CREATE TYPE "waxon_v2"."learning_path_node_kind" AS ENUM('target', 'external_prerequisite');--> statement-breakpoint
CREATE TYPE "waxon_v2"."learning_path_status" AS ENUM('ready', 'fallback_ready', 'needs_attention', 'superseded');--> statement-breakpoint
CREATE TABLE "waxon_v2"."review_session_item_path_nodes" (
	"user_id" text NOT NULL,
	"session_item_id" uuid NOT NULL,
	"path_node_id" uuid NOT NULL,
	CONSTRAINT "review_session_item_path_nodes_pk" PRIMARY KEY("user_id","session_item_id","path_node_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_focus_stack" (
	"user_id" text NOT NULL,
	"depth" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	"parent_gap_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_focus_stack_pk" PRIMARY KEY("user_id","depth"),
	CONSTRAINT "source_focus_stack_depth_valid" CHECK ("waxon_v2"."source_focus_stack"."depth" >= 0)
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_learning_edges" (
	"user_id" text NOT NULL,
	"path_id" uuid NOT NULL,
	"prerequisite_node_id" uuid NOT NULL,
	"dependent_node_id" uuid NOT NULL,
	CONSTRAINT "source_learning_edges_pk" PRIMARY KEY("user_id","path_id","prerequisite_node_id","dependent_node_id"),
	CONSTRAINT "source_learning_edges_not_self" CHECK ("waxon_v2"."source_learning_edges"."prerequisite_node_id" <> "waxon_v2"."source_learning_edges"."dependent_node_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_learning_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"path_id" uuid NOT NULL,
	"kind" "waxon_v2"."learning_path_node_kind" NOT NULL,
	"target_id" uuid,
	"question_id" uuid,
	"bridge_source_id" uuid,
	"module_title" text NOT NULL,
	"module_position" integer NOT NULL,
	"source_position" integer NOT NULL,
	"pedagogical_position" integer NOT NULL,
	"statement" text NOT NULL,
	"reason" text,
	"introduced_at" timestamp with time zone,
	"passed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_learning_nodes_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "source_learning_nodes_path_position_unique" UNIQUE("user_id","path_id","pedagogical_position"),
	CONSTRAINT "source_learning_nodes_target_kind_valid" CHECK (("waxon_v2"."source_learning_nodes"."kind" = 'target' AND "waxon_v2"."source_learning_nodes"."target_id" IS NOT NULL) OR ("waxon_v2"."source_learning_nodes"."kind" = 'external_prerequisite' AND "waxon_v2"."source_learning_nodes"."target_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."source_learning_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"status" "waxon_v2"."learning_path_status" NOT NULL,
	"policy_version" text NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_learning_paths_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "source_learning_paths_generation_run_unique" UNIQUE("user_id","generation_run_id")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" ADD COLUMN "estimated_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" ADD COLUMN "source_context" jsonb;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_sessions" ADD COLUMN "reserved_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_item_path_nodes" ADD CONSTRAINT "review_session_item_path_nodes_item_fk" FOREIGN KEY ("user_id","session_item_id") REFERENCES "waxon_v2"."review_session_items"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_item_path_nodes" ADD CONSTRAINT "review_session_item_path_nodes_node_fk" FOREIGN KEY ("user_id","path_node_id") REFERENCES "waxon_v2"."source_learning_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_focus_stack" ADD CONSTRAINT "source_focus_stack_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_focus_stack" ADD CONSTRAINT "source_focus_stack_source_fk" FOREIGN KEY ("user_id","source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_focus_stack" ADD CONSTRAINT "source_focus_stack_path_fk" FOREIGN KEY ("user_id","path_id") REFERENCES "waxon_v2"."source_learning_paths"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_focus_stack" ADD CONSTRAINT "source_focus_stack_parent_gap_fk" FOREIGN KEY ("user_id","parent_gap_node_id") REFERENCES "waxon_v2"."source_learning_nodes"("user_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_edges" ADD CONSTRAINT "source_learning_edges_path_fk" FOREIGN KEY ("user_id","path_id") REFERENCES "waxon_v2"."source_learning_paths"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_edges" ADD CONSTRAINT "source_learning_edges_prerequisite_fk" FOREIGN KEY ("user_id","prerequisite_node_id") REFERENCES "waxon_v2"."source_learning_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_edges" ADD CONSTRAINT "source_learning_edges_dependent_fk" FOREIGN KEY ("user_id","dependent_node_id") REFERENCES "waxon_v2"."source_learning_nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_path_fk" FOREIGN KEY ("user_id","path_id") REFERENCES "waxon_v2"."source_learning_paths"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_target_fk" FOREIGN KEY ("user_id","target_id") REFERENCES "waxon_v2"."coverage_targets"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_bridge_source_fk" FOREIGN KEY ("user_id","bridge_source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_paths" ADD CONSTRAINT "source_learning_paths_source_fk" FOREIGN KEY ("user_id","source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_paths" ADD CONSTRAINT "source_learning_paths_revision_fk" FOREIGN KEY ("user_id","source_revision_id") REFERENCES "waxon_v2"."source_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_paths" ADD CONSTRAINT "source_learning_paths_generation_run_fk" FOREIGN KEY ("user_id","generation_run_id") REFERENCES "waxon_v2"."generation_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_session_item_path_nodes_node_idx" ON "waxon_v2"."review_session_item_path_nodes" USING btree ("user_id","path_node_id");--> statement-breakpoint
CREATE INDEX "source_focus_stack_active_idx" ON "waxon_v2"."source_focus_stack" USING btree ("user_id","depth");--> statement-breakpoint
CREATE INDEX "source_learning_edges_dependent_idx" ON "waxon_v2"."source_learning_edges" USING btree ("user_id","path_id","dependent_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_learning_nodes_path_target_unique" ON "waxon_v2"."source_learning_nodes" USING btree ("user_id","path_id","target_id") WHERE "waxon_v2"."source_learning_nodes"."target_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "source_learning_nodes_path_order_idx" ON "waxon_v2"."source_learning_nodes" USING btree ("user_id","path_id","pedagogical_position");--> statement-breakpoint
CREATE INDEX "source_learning_nodes_question_progress_idx" ON "waxon_v2"."source_learning_nodes" USING btree ("user_id","question_id","passed_at");--> statement-breakpoint
CREATE INDEX "source_learning_paths_source_status_idx" ON "waxon_v2"."source_learning_paths" USING btree ("user_id","source_id","status");