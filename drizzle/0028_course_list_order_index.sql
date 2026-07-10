CREATE INDEX IF NOT EXISTS "courses_user_updated_id_idx"
ON "courses" USING btree ("user_id", "updated_at" DESC, "id" DESC);
