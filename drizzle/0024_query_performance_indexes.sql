CREATE INDEX IF NOT EXISTS "decks_active_user_updated_idx"
  ON "decks" ("user_id", "updated_at" DESC, "name")
  WHERE "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "question_attempts_deck_submitted_idx"
  ON "question_attempts" ("deck_id", "submitted_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "question_attempts_deck_resolved_idx"
  ON "question_attempts" ("deck_id", "resolved_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "question_embeddings_current_nonempty_lookup_idx"
  ON "question_embeddings" (
    "deck_id",
    "embedding_model",
    "embedding_kind",
    "source_version"
  )
  WHERE "is_current" = true AND "source_hash" <> '';

CREATE INDEX IF NOT EXISTS "concept_tags_embedding_hnsw_idx"
  ON "concept_tags" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops)
  WHERE "embedding" IS NOT NULL AND "slug" NOT LIKE 'course-%';

CREATE INDEX IF NOT EXISTS "answer_evaluations_trace_id_idx"
  ON "answer_evaluations" ("trace_id");
