CREATE TYPE "waxon_v2"."question_flag_origin" AS ENUM('waxon_validation', 'learner');--> statement-breakpoint
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
ALTER TABLE "waxon_v2"."question_flags" ADD CONSTRAINT "question_flags_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_flags_question_created_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id","created_at");--> statement-breakpoint
CREATE INDEX "question_flags_unresolved_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id") WHERE "waxon_v2"."question_flags"."resolved_at" IS NULL;