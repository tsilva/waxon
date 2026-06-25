ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "metrics" jsonb;
--> statement-breakpoint
ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "evaluation" jsonb;
--> statement-breakpoint
ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "widget_answer" jsonb;
