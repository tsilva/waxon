ALTER TABLE "course_chat_messages" ADD COLUMN IF NOT EXISTS "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL;
