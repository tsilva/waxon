DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "questions" item
    INNER JOIN "decks" deck ON deck."id" = item."deck_id"
    WHERE item."user_id" <> deck."user_id"
  ) OR EXISTS (
    SELECT 1 FROM "question_attempts" item
    INNER JOIN "decks" deck ON deck."id" = item."deck_id"
    WHERE item."user_id" <> deck."user_id"
  ) OR EXISTS (
    SELECT 1 FROM "question_embeddings" item
    INNER JOIN "decks" deck ON deck."id" = item."deck_id"
    WHERE item."user_id" <> deck."user_id"
  ) OR EXISTS (
    SELECT 1 FROM "answer_evaluations" item
    INNER JOIN "decks" deck ON deck."id" = item."deck_id"
    WHERE item."user_id" <> deck."user_id"
  ) OR EXISTS (
    SELECT 1 FROM "courses" item
    INNER JOIN "decks" deck ON deck."id" = item."deck_id"
    WHERE item."user_id" <> deck."user_id"
  ) THEN
    RAISE EXCEPTION 'deck ownership does not match user-scoped data';
  END IF;
END $$;--> statement-breakpoint

UPDATE "questions"
SET "concise_answer" = "reference_answer"
WHERE length(trim("concise_answer")) = 0
  AND length(trim("reference_answer")) > 0;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.questions_trash') IS NOT NULL THEN
    UPDATE "questions_trash"
    SET "concise_answer" = "reference_answer"
    WHERE length(trim("concise_answer")) = 0
      AND length(trim("reference_answer")) > 0;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "answer_evaluations" DROP CONSTRAINT IF EXISTS "answer_evaluations_deck_id_decks_id_fk";--> statement-breakpoint
ALTER TABLE "courses" DROP CONSTRAINT IF EXISTS "courses_deck_id_decks_id_fk";--> statement-breakpoint
ALTER TABLE "question_attempts" DROP CONSTRAINT IF EXISTS "question_attempts_deck_id_decks_id_fk";--> statement-breakpoint
ALTER TABLE "question_attempts" DROP CONSTRAINT IF EXISTS "question_attempts_deck_question_id_fk";--> statement-breakpoint
ALTER TABLE "question_embeddings" DROP CONSTRAINT IF EXISTS "question_embeddings_deck_id_decks_id_fk";--> statement-breakpoint
ALTER TABLE "question_embeddings" DROP CONSTRAINT IF EXISTS "question_embeddings_deck_question_id_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_deck_generated_from_question_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_deck_id_decks_id_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_deck_id_unique";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_deck_question_unique";--> statement-breakpoint

ALTER TABLE "answer_evaluations" DROP COLUMN "deck_id";--> statement-breakpoint
ALTER TABLE "courses" DROP COLUMN "deck_id";--> statement-breakpoint
ALTER TABLE "question_attempts" DROP COLUMN "deck_id";--> statement-breakpoint
ALTER TABLE "question_embeddings" DROP COLUMN "deck_id";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "deck_id";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "reference_answer";--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.questions_trash') IS NOT NULL THEN
    ALTER TABLE "questions_trash" RENAME COLUMN "deck_id" TO "legacy_deck_id";
    ALTER TABLE "questions_trash" DROP COLUMN "reference_answer";
    COMMENT ON COLUMN "questions_trash"."legacy_deck_id" IS
      'Opaque provenance retained for the pre-user-scope duplicate archive; not an application relationship.';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "decks";
