CREATE TABLE "decks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"deck_id" text NOT NULL,
	"question" text NOT NULL,
	"raw_answer" text NOT NULL,
	"answer_summary" text NOT NULL,
	"score" integer NOT NULL,
	"justification" text NOT NULL,
	"submitted_at" bigint NOT NULL,
	"resolved_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"question" text PRIMARY KEY NOT NULL,
	"deck_id" text NOT NULL,
	"reviews" text DEFAULT '' NOT NULL,
	"next_due" bigint DEFAULT 0 NOT NULL,
	"last_answer" text DEFAULT '' NOT NULL,
	"last_answer_summary" text DEFAULT '' NOT NULL,
	"reference_answer" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_questions_question_fk" FOREIGN KEY ("question") REFERENCES "public"."questions"("question") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decks_user_slug_idx" ON "decks" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "question_attempts_question_submitted_idx" ON "question_attempts" USING btree ("question","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "question_attempts_deck_question_submitted_idx" ON "question_attempts" USING btree ("deck_id","question","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "questions_next_due_idx" ON "questions" USING btree ("next_due");--> statement-breakpoint
CREATE INDEX "questions_deck_next_due_idx" ON "questions" USING btree ("deck_id","next_due");