CREATE TABLE "answer_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"deck_id" text NOT NULL,
	"question" text NOT NULL,
	"raw_answer" text NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"last_activity_at" bigint NOT NULL,
	"score" integer,
	"justification" text,
	"answer_summary" text,
	"next_due" bigint,
	"submitted_at" bigint NOT NULL,
	"resolved_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "answer_evaluations_id_nonempty_check" CHECK (length(trim("answer_evaluations"."id")) > 0),
	CONSTRAINT "answer_evaluations_trace_id_nonempty_check" CHECK (length(trim("answer_evaluations"."trace_id")) > 0),
	CONSTRAINT "answer_evaluations_question_nonempty_check" CHECK (length(trim("answer_evaluations"."question")) > 0),
	CONSTRAINT "answer_evaluations_status_check" CHECK ("answer_evaluations"."status" IN ('grading', 'resolved')),
	CONSTRAINT "answer_evaluations_phase_check" CHECK ("answer_evaluations"."phase" IS NULL OR "answer_evaluations"."phase" IN (
        'queued',
        'evaluating-answer',
        'saving-evaluation',
        'gating-probes',
        'saving-probes',
        'finalizing'
      )),
	CONSTRAINT "answer_evaluations_score_check" CHECK ("answer_evaluations"."score" IS NULL OR "answer_evaluations"."score" BETWEEN 0 AND 10),
	CONSTRAINT "answer_evaluations_last_activity_at_check" CHECK ("answer_evaluations"."last_activity_at" >= 0),
	CONSTRAINT "answer_evaluations_submitted_at_check" CHECK ("answer_evaluations"."submitted_at" >= 0),
	CONSTRAINT "answer_evaluations_resolved_at_check" CHECK ("answer_evaluations"."resolved_at" IS NULL OR "answer_evaluations"."resolved_at" >= "answer_evaluations"."submitted_at"),
	CONSTRAINT "answer_evaluations_created_at_check" CHECK ("answer_evaluations"."created_at" >= 0),
	CONSTRAINT "answer_evaluations_updated_at_check" CHECK ("answer_evaluations"."updated_at" >= "answer_evaluations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "answer_evaluations_user_status_submitted_idx" ON "answer_evaluations" USING btree ("user_id","status","submitted_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "answer_evaluations_deck_submitted_idx" ON "answer_evaluations" USING btree ("deck_id","submitted_at" DESC NULLS LAST);
