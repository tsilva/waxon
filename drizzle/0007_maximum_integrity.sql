CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
UPDATE "questions" SET "id" = gen_random_uuid() WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD COLUMN "question_id" uuid;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "question_id" uuid;--> statement-breakpoint
UPDATE "question_attempts" qa
SET "question_id" = q."id"
FROM "questions" q
WHERE qa."deck_id" = q."deck_id"
  AND qa."question" = q."question";--> statement-breakpoint
UPDATE "question_embeddings" qe
SET "question_id" = q."id"
FROM "questions" q
WHERE qe."deck_id" = q."deck_id"
  AND qe."question" = q."question";--> statement-breakpoint
ALTER TABLE "question_attempts" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question_attempts" DROP CONSTRAINT "question_attempts_question_questions_question_fk";--> statement-breakpoint
ALTER TABLE "question_embeddings" DROP CONSTRAINT "question_embeddings_question_questions_question_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_generated_from_question_questions_question_fk";--> statement-breakpoint
DROP INDEX "questions_question_slug_idx";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_pkey";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_deck_id_unique" UNIQUE ("deck_id", "id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_id_question_unique" UNIQUE ("id", "question");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_deck_question_unique" UNIQUE ("deck_id", "question");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_deck_question_slug_idx" ON "questions" USING btree ("deck_id", "question_slug");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_deck_generated_from_question_fk" FOREIGN KEY ("deck_id", "generated_from_question") REFERENCES "public"."questions"("deck_id", "question") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX "question_embeddings_current_source_idx";--> statement-breakpoint
DROP INDEX "question_embeddings_question_lookup_idx";--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_deck_question_id_fk" FOREIGN KEY ("deck_id", "question_id") REFERENCES "public"."questions"("deck_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_question_id_question_fk" FOREIGN KEY ("question_id", "question") REFERENCES "public"."questions"("id", "question") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_deck_question_id_fk" FOREIGN KEY ("deck_id", "question_id") REFERENCES "public"."questions"("deck_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_question_id_question_fk" FOREIGN KEY ("question_id", "question") REFERENCES "public"."questions"("id", "question") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_embeddings_current_source_idx" ON "question_embeddings" USING btree ("deck_id", "question_id", "embedding_model", "embedding_kind", "source_version");--> statement-breakpoint
CREATE INDEX "question_embeddings_question_lookup_idx" ON "question_embeddings" USING btree ("question_id", "embedding_model", "embedding_kind");--> statement-breakpoint
CREATE INDEX "question_embeddings_question_text_lookup_idx" ON "question_embeddings" USING btree ("question", "embedding_model", "embedding_kind");--> statement-breakpoint
ALTER TABLE "question_embeddings" ALTER COLUMN "embedding" TYPE vector(3072) USING "embedding"::vector(3072);--> statement-breakpoint
CREATE TABLE "question_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"attempt_id" integer NOT NULL,
	"deck_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"question" text NOT NULL,
	"score" integer NOT NULL,
	"submitted_at" bigint NOT NULL,
	"resolved_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "question_reviews_attempt_id_unique" UNIQUE ("attempt_id"),
	CONSTRAINT "question_reviews_score_check" CHECK ("score" BETWEEN 0 AND 10),
	CONSTRAINT "question_reviews_submitted_at_check" CHECK ("submitted_at" >= 0),
	CONSTRAINT "question_reviews_resolved_at_check" CHECK ("resolved_at" >= "submitted_at"),
	CONSTRAINT "question_reviews_created_at_check" CHECK ("created_at" >= 0)
);--> statement-breakpoint
INSERT INTO "question_reviews" (
	"attempt_id",
	"deck_id",
	"question_id",
	"question",
	"score",
	"submitted_at",
	"resolved_at",
	"created_at"
)
SELECT
	qa."id",
	qa."deck_id",
	qa."question_id",
	qa."question",
	qa."score",
	qa."submitted_at",
	qa."resolved_at",
	qa."resolved_at"
FROM "question_attempts" qa;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_attempt_id_question_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."question_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_deck_question_id_fk" FOREIGN KEY ("deck_id", "question_id") REFERENCES "public"."questions"("deck_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_question_id_question_fk" FOREIGN KEY ("question_id", "question") REFERENCES "public"."questions"("id", "question") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_reviews_deck_question_submitted_idx" ON "question_reviews" USING btree ("deck_id", "question", "submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "question_reviews_question_id_submitted_idx" ON "question_reviews" USING btree ("question_id", "submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "question_reviews_question_id_resolved_idx" ON "question_reviews" USING btree ("question_id", "resolved_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_nonempty_check" CHECK (length(trim("id")) > 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_nonempty_check" CHECK (length(trim("display_name")) > 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_nonempty_check" CHECK (length(trim("email")) > 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_url_check" CHECK ("avatar_url" IS NULL OR (length("avatar_url") <= 700000 AND "avatar_url" ~ '^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_at_check" CHECK ("created_at" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_updated_at_check" CHECK ("updated_at" >= "created_at");--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_id_nonempty_check" CHECK (length(trim("id")) > 0);--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_name_nonempty_check" CHECK (length(trim("name")) > 0);--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_slug_nonempty_check" CHECK (length(trim("slug")) > 0);--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_created_at_check" CHECK ("created_at" >= 0);--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_updated_at_check" CHECK ("updated_at" >= "created_at");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_nonempty_check" CHECK (length(trim("question")) > 0);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_slug_nonempty_check" CHECK (length(trim("question_slug")) > 0);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_next_due_check" CHECK ("next_due" >= 0);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_reviews_format_check" CHECK ("reviews" = '' OR "reviews" ~ '^[0-9]+:(10|[0-9])(\|[0-9]+:(10|[0-9]))*$');--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_at_check" CHECK ("created_at" >= 0);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_updated_at_check" CHECK ("updated_at" >= "created_at");--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_score_check" CHECK ("score" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_submitted_at_check" CHECK ("submitted_at" >= 0);--> statement-breakpoint
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_resolved_at_check" CHECK ("resolved_at" >= "submitted_at");--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_model_nonempty_check" CHECK (length(trim("embedding_model")) > 0);--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_kind_nonempty_check" CHECK (length(trim("embedding_kind")) > 0);--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_source_version_check" CHECK ("source_version" > 0);--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_source_hash_check" CHECK (length("source_hash") <= 128);--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_created_at_check" CHECK ("created_at" >= 0);--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_updated_at_check" CHECK ("updated_at" >= "created_at");
