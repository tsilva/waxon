ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "conversation_cost" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_conversation_cost_check" CHECK ("conversation_cost" >= 0);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "course_chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "sequence" integer NOT NULL,
  "created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  "updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  CONSTRAINT "course_chat_messages_role_check" CHECK ("role" IN ('assistant', 'user')),
  CONSTRAINT "course_chat_messages_content_nonempty_check" CHECK (length(trim("content")) > 0),
  CONSTRAINT "course_chat_messages_sequence_check" CHECK ("sequence" >= 0),
  CONSTRAINT "course_chat_messages_created_at_check" CHECK ("created_at" >= 0),
  CONSTRAINT "course_chat_messages_updated_at_check" CHECK ("updated_at" >= "created_at")
);
--> statement-breakpoint
ALTER TABLE "course_chat_messages" ADD CONSTRAINT "course_chat_messages_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_chat_messages_course_sequence_idx"
ON "course_chat_messages" USING btree ("course_id", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "course_chat_messages_course_created_idx"
ON "course_chat_messages" USING btree ("course_id", "created_at");
