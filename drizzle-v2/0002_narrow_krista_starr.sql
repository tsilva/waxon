CREATE TABLE "waxon_v2"."repair_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"parent_question_id" uuid NOT NULL,
	"child_question_id" uuid NOT NULL,
	"demonstrated_gap" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_drafts_submission_unique" UNIQUE("user_id","submission_id")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."repair_drafts" ADD CONSTRAINT "repair_drafts_submission_fk" FOREIGN KEY ("user_id","submission_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."repair_drafts" ADD CONSTRAINT "repair_drafts_parent_question_fk" FOREIGN KEY ("user_id","parent_question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."repair_drafts" ADD CONSTRAINT "repair_drafts_child_question_fk" FOREIGN KEY ("user_id","child_question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;