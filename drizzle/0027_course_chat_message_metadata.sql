ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "metrics" jsonb;
ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "evaluation" jsonb;
ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "widget_answer" jsonb;
