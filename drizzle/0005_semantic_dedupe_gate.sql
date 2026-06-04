ALTER TABLE "questions" ADD COLUMN "concise_answer" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "deck_id" text;--> statement-breakpoint
UPDATE "question_embeddings" qe
SET "deck_id" = q."deck_id"
FROM "questions" q
WHERE qe."question" = q."question";--> statement-breakpoint
ALTER TABLE "question_embeddings" ALTER COLUMN "deck_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "embedding_kind" text DEFAULT 'question_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "source_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "source_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "question_embeddings_question_model_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "question_embeddings_current_source_idx" ON "question_embeddings" USING btree ("deck_id","question","embedding_model","embedding_kind","source_version");--> statement-breakpoint
CREATE INDEX "question_embeddings_lookup_idx" ON "question_embeddings" USING btree ("deck_id","embedding_model","embedding_kind","source_version","is_current");--> statement-breakpoint
CREATE INDEX "question_embeddings_question_lookup_idx" ON "question_embeddings" USING btree ("question","embedding_model","embedding_kind");--> statement-breakpoint
CREATE INDEX "question_embeddings_dedupe_hnsw_idx" ON "question_embeddings" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops)
WHERE "embedding_kind" = 'dedupe_v1' AND "is_current" = true;
