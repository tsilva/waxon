CREATE TABLE IF NOT EXISTS "courses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "deck_id" text NOT NULL,
  "topic_prompt" text NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "toc" jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "current_chapter_index" integer DEFAULT 0 NOT NULL,
  "current_page_index" integer DEFAULT 0 NOT NULL,
  "created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  "updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  CONSTRAINT "courses_topic_prompt_nonempty_check" CHECK (length(trim("topic_prompt")) > 0),
  CONSTRAINT "courses_title_nonempty_check" CHECK (length(trim("title")) > 0),
  CONSTRAINT "courses_status_check" CHECK ("status" IN ('active', 'completed')),
  CONSTRAINT "courses_current_chapter_index_check" CHECK ("current_chapter_index" >= 0),
  CONSTRAINT "courses_current_page_index_check" CHECK ("current_page_index" >= 0),
  CONSTRAINT "courses_created_at_check" CHECK ("created_at" >= 0),
  CONSTRAINT "courses_updated_at_check" CHECK ("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "course_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL,
  "question_id" uuid,
  "chapter_index" integer NOT NULL,
  "page_index" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "summary" text NOT NULL,
  "question" text NOT NULL,
  "choices" jsonb NOT NULL,
  "correct_choice_id" text NOT NULL,
  "correct_answer" text NOT NULL,
  "explanation" text DEFAULT '' NOT NULL,
  "created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  "updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  CONSTRAINT "course_pages_chapter_index_check" CHECK ("chapter_index" >= 0),
  CONSTRAINT "course_pages_page_index_check" CHECK ("page_index" >= 0),
  CONSTRAINT "course_pages_title_nonempty_check" CHECK (length(trim("title")) > 0),
  CONSTRAINT "course_pages_body_nonempty_check" CHECK (length(trim("body")) > 0),
  CONSTRAINT "course_pages_summary_nonempty_check" CHECK (length(trim("summary")) > 0),
  CONSTRAINT "course_pages_question_nonempty_check" CHECK (length(trim("question")) > 0),
  CONSTRAINT "course_pages_correct_choice_id_nonempty_check" CHECK (length(trim("correct_choice_id")) > 0),
  CONSTRAINT "course_pages_correct_answer_nonempty_check" CHECK (length(trim("correct_answer")) > 0),
  CONSTRAINT "course_pages_created_at_check" CHECK ("created_at" >= 0),
  CONSTRAINT "course_pages_updated_at_check" CHECK ("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "course_page_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "course_id" uuid NOT NULL,
  "page_id" uuid NOT NULL,
  "selected_choice_id" text NOT NULL,
  "is_correct" boolean NOT NULL,
  "feedback" text DEFAULT '' NOT NULL,
  "attempted_at" bigint NOT NULL,
  CONSTRAINT "course_page_attempts_selected_choice_id_nonempty_check" CHECK (length(trim("selected_choice_id")) > 0),
  CONSTRAINT "course_page_attempts_attempted_at_check" CHECK ("attempted_at" >= 0)
);
--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "course_pages" ADD CONSTRAINT "course_pages_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "course_pages" ADD CONSTRAINT "course_pages_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "course_page_attempts" ADD CONSTRAINT "course_page_attempts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "course_page_attempts" ADD CONSTRAINT "course_page_attempts_page_id_course_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."course_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courses_user_status_updated_idx"
ON "courses" USING btree ("user_id", "status", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courses_deck_id_idx"
ON "courses" USING btree ("deck_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_pages_course_position_idx"
ON "course_pages" USING btree ("course_id", "chapter_index", "page_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "course_pages_question_id_idx"
ON "course_pages" USING btree ("question_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "course_page_attempts_course_page_idx"
ON "course_page_attempts" USING btree ("course_id", "page_id", "attempted_at" DESC);
