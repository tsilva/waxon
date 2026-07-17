-- Retire the hidden course-tag namespace now that Courses is no longer a
-- product surface. question_concept_tags rows are removed by ON DELETE CASCADE.
DELETE FROM "concept_tags"
WHERE "slug" LIKE 'course-%';--> statement-breakpoint

-- The course prefix no longer needs to be excluded from semantic lookup.
DROP INDEX IF EXISTS "concept_tags_embedding_hnsw_idx";--> statement-breakpoint
CREATE INDEX "concept_tags_embedding_hnsw_idx"
ON "concept_tags" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops)
WHERE "embedding" IS NOT NULL;
