CREATE INDEX IF NOT EXISTS "decks_user_rotation_archive_idx"
  ON "decks" ("user_id", "in_review_rotation", "archived_at");

CREATE INDEX IF NOT EXISTS "questions_active_deck_due_idx"
  ON "questions" ("deck_id", "next_due", "created_at", "question")
  WHERE "flagged_at" IS NULL;

CREATE INDEX IF NOT EXISTS "questions_active_deck_created_idx"
  ON "questions" ("deck_id", "created_at" DESC, "question")
  WHERE "flagged_at" IS NULL;
