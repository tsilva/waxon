ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
UPDATE "questions" questions
SET "user_id" = decks."user_id"
FROM "decks" decks
WHERE questions."deck_id" = decks."id"
  AND questions."user_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "questions" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'questions.user_id backfill left null rows';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'questions_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "questions" ADD CONSTRAINT "questions_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "question_attempts" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
UPDATE "question_attempts" question_attempts
SET "user_id" = questions."user_id"
FROM "questions" questions
WHERE question_attempts."question_id" = questions."id"
  AND question_attempts."user_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "question_attempts" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'question_attempts.user_id backfill left null rows';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "question_attempts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'question_attempts_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "question_attempts" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "question_embeddings" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
UPDATE "question_embeddings" question_embeddings
SET "user_id" = questions."user_id"
FROM "questions" questions
WHERE question_embeddings."question_id" = questions."id"
  AND question_embeddings."user_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "question_embeddings" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'question_embeddings.user_id backfill left null rows';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "question_embeddings" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'question_embeddings_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "question_embeddings" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "answer_evaluations" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "questions_user_question_slug_idx"
  ON "questions" USING btree ("user_id", "question_slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "questions_user_question_idx"
  ON "questions" USING btree ("user_id", "question");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_user_next_due_idx"
  ON "questions" USING btree ("user_id", "next_due");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_active_user_due_idx"
  ON "questions" USING btree ("user_id", "next_due", "created_at", "question")
  WHERE "flagged_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_active_user_created_idx"
  ON "questions" USING btree ("user_id", "created_at" DESC, "question")
  WHERE "flagged_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "question_attempts_user_question_submitted_idx"
  ON "question_attempts" USING btree ("user_id", "question", "submitted_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_attempts_user_submitted_idx"
  ON "question_attempts" USING btree ("user_id", "submitted_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_attempts_user_resolved_idx"
  ON "question_attempts" USING btree ("user_id", "resolved_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_attempts_question_id_submitted_idx"
  ON "question_attempts" USING btree ("question_id", "submitted_at" DESC);--> statement-breakpoint

DROP INDEX IF EXISTS "question_embeddings_current_source_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "question_embeddings_lookup_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "question_embeddings_current_nonempty_lookup_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "question_embeddings_current_source_idx"
  ON "question_embeddings" USING btree (
    "user_id",
    "question_id",
    "embedding_model",
    "embedding_kind",
    "source_version"
  );--> statement-breakpoint
CREATE INDEX "question_embeddings_lookup_idx"
  ON "question_embeddings" USING btree (
    "user_id",
    "embedding_model",
    "embedding_kind",
    "source_version",
    "is_current"
  );--> statement-breakpoint
CREATE INDEX "question_embeddings_current_nonempty_lookup_idx"
  ON "question_embeddings" USING btree (
    "user_id",
    "embedding_model",
    "embedding_kind",
    "source_version"
  )
  WHERE "is_current" = true AND "source_hash" <> '';--> statement-breakpoint
