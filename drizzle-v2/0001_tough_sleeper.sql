CREATE TYPE "waxon_v2"."recall_result" AS ENUM('incorrect', 'partial', 'correct');--> statement-breakpoint
CREATE TABLE "waxon_v2"."recall_result_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"recall_result" "waxon_v2"."recall_result" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_result_corrections_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD COLUMN "proposed_recall_result" "waxon_v2"."recall_result";--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD COLUMN "scoring_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD COLUMN "clarifications" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD COLUMN "derivation_version" text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."recall_result_corrections" ADD CONSTRAINT "recall_result_corrections_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."recall_result_corrections" ADD CONSTRAINT "recall_result_corrections_submission_question_fk" FOREIGN KEY ("user_id","submission_id","question_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id","question_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_result_corrections_submission_created_idx" ON "waxon_v2"."recall_result_corrections" USING btree ("user_id","submission_id","created_at");