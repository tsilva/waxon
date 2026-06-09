ALTER TABLE "questions" ADD COLUMN "flagged_at" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_deck_flagged_next_due_idx"
ON "questions" USING btree ("deck_id", "flagged_at", "next_due");
