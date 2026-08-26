ALTER TABLE "waxon_v2"."questions" ADD COLUMN IF NOT EXISTS "prompt" text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ADD COLUMN IF NOT EXISTS "reference_answer" text;--> statement-breakpoint
CREATE TEMP TABLE "issue18_question_identity_map" ON COMMIT DROP AS
WITH ranked_versions AS (
	SELECT "user_id", "question_id", "id" AS "question_version_id",
		row_number() OVER (
			PARTITION BY "user_id", "question_id"
			ORDER BY "is_current" DESC, "version" DESC, "created_at" DESC, "id" DESC
		) = 1 AS "is_canonical"
	FROM "waxon_v2"."question_versions"
)
SELECT "user_id", "question_id" AS "canonical_question_id", "question_version_id",
	CASE WHEN "is_canonical" THEN "question_id" ELSE "question_version_id" END AS "immutable_question_id",
	"is_canonical"
FROM ranked_versions;--> statement-breakpoint
DO $$
DECLARE
	identity_collision_count bigint;
BEGIN
	SELECT count(*) INTO identity_collision_count
	FROM "issue18_question_identity_map" AS "identity"
	JOIN "waxon_v2"."questions" AS "question"
		ON "question"."id" = "identity"."immutable_question_id"
	WHERE NOT "identity"."is_canonical";
	IF identity_collision_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration found % historical Question identity collisions', identity_collision_count;
	END IF;
END $$;--> statement-breakpoint
UPDATE "waxon_v2"."questions" AS "question"
SET "prompt" = "version"."prompt",
	"reference_answer" = "version"."reference_answer"
FROM "issue18_question_identity_map" AS "identity"
JOIN "waxon_v2"."question_versions" AS "version"
	ON "version"."user_id" = "identity"."user_id"
	AND "version"."id" = "identity"."question_version_id"
WHERE "identity"."is_canonical"
	AND "question"."user_id" = "identity"."user_id"
	AND "question"."id" = "identity"."canonical_question_id"
	AND ("question"."prompt" IS NULL OR "question"."reference_answer" IS NULL);--> statement-breakpoint
INSERT INTO "waxon_v2"."questions" (
	"id", "user_id", "prompt", "reference_answer", "lifecycle", "target_key", "created_at", "updated_at"
)
SELECT "identity"."immutable_question_id", "identity"."user_id",
	"version"."prompt", "version"."reference_answer", 'archived',
	encode(sha256(convert_to(
		trim(regexp_replace(
			lower(normalize("version"."prompt", NFKC) COLLATE "und-x-icu"),
			U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028-\2029\202F\205F\3000\FEFF]+',
			' ', 'g'
		)),
		'UTF8'
	)), 'hex'),
	"version"."created_at", "version"."created_at"
FROM "issue18_question_identity_map" AS "identity"
JOIN "waxon_v2"."question_versions" AS "version"
	ON "version"."user_id" = "identity"."user_id"
	AND "version"."id" = "identity"."question_version_id"
WHERE NOT "identity"."is_canonical";--> statement-breakpoint
UPDATE "waxon_v2"."answer_submissions" AS "submission"
SET "question_id" = "identity"."immutable_question_id"
FROM "issue18_question_identity_map" AS "identity"
WHERE "submission"."user_id" = "identity"."user_id"
	AND "submission"."question_version_id" = "identity"."question_version_id";--> statement-breakpoint
UPDATE "waxon_v2"."question_search_embeddings" AS "embedding"
SET "question_id" = "identity"."immutable_question_id"
FROM "issue18_question_identity_map" AS "identity"
WHERE "embedding"."user_id" = "identity"."user_id"
	AND "embedding"."question_version_id" = "identity"."question_version_id";--> statement-breakpoint
DELETE FROM "waxon_v2"."memory_states" AS "memory"
WHERE EXISTS (
	SELECT 1
	FROM "issue18_question_identity_map" AS "identity"
	WHERE "identity"."user_id" = "memory"."user_id"
		AND "identity"."canonical_question_id" = "memory"."question_id"
	GROUP BY "identity"."user_id", "identity"."canonical_question_id"
	HAVING count(*) > 1
);--> statement-breakpoint
DO $$
DECLARE
	invalid_count bigint;
BEGIN
	SELECT count(*) INTO invalid_count
	FROM "waxon_v2"."questions"
	WHERE "prompt" IS NULL OR "reference_answer" IS NULL;
	IF invalid_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration found % Questions without canonical content', invalid_count;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "prompt" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "reference_answer" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "waxon_v2"."questions_active_target_unique";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" DROP COLUMN IF EXISTS "prior_lifecycle";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DATA TYPE text USING "lifecycle"::text;--> statement-breakpoint
DO $$
DECLARE
	unmapped_lifecycle_count bigint;
BEGIN
	SELECT count(*) INTO unmapped_lifecycle_count
	FROM "waxon_v2"."questions"
	WHERE "lifecycle" NOT IN ('new', 'learning', 'review', 'flagged', 'paused', 'archived', 'trash');
	IF unmapped_lifecycle_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration found % Questions with unmapped lifecycle values', unmapped_lifecycle_count;
	END IF;
END $$;--> statement-breakpoint
UPDATE "waxon_v2"."questions"
SET "lifecycle" = CASE
	WHEN "lifecycle" IN ('new', 'learning', 'review') THEN 'active'
	WHEN "lifecycle" = 'flagged' THEN 'flagged'
	WHEN "lifecycle" IN ('paused', 'archived', 'trash') THEN 'archived'
	ELSE "lifecycle"
END;--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."question_lifecycle";--> statement-breakpoint
CREATE TYPE "waxon_v2"."question_lifecycle" AS ENUM('active', 'flagged', 'archived');--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DATA TYPE "waxon_v2"."question_lifecycle" USING "lifecycle"::"waxon_v2"."question_lifecycle";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DEFAULT 'active'::"waxon_v2"."question_lifecycle";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" ADD COLUMN IF NOT EXISTS "question_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ADD COLUMN IF NOT EXISTS "question_id" uuid;--> statement-breakpoint
UPDATE "waxon_v2"."question_embeddings" AS "embedding"
SET "question_id" = "identity"."immutable_question_id"
FROM "issue18_question_identity_map" AS "identity"
WHERE "embedding"."user_id" = "identity"."user_id"
	AND "embedding"."question_version_id" = "identity"."question_version_id"
	AND "embedding"."question_id" IS NULL;--> statement-breakpoint
UPDATE "waxon_v2"."question_evidence" AS "evidence"
SET "question_id" = "identity"."immutable_question_id"
FROM "issue18_question_identity_map" AS "identity"
WHERE "evidence"."user_id" = "identity"."user_id"
	AND "evidence"."question_version_id" = "identity"."question_version_id"
	AND "evidence"."question_id" IS NULL;--> statement-breakpoint
DO $$
DECLARE
	invalid_embedding_count bigint;
	invalid_evidence_count bigint;
BEGIN
	SELECT count(*) INTO invalid_embedding_count
	FROM "waxon_v2"."question_embeddings"
	WHERE "question_id" IS NULL;
	SELECT count(*) INTO invalid_evidence_count
	FROM "waxon_v2"."question_evidence"
	WHERE "question_id" IS NULL;
	IF invalid_embedding_count > 0 OR invalid_evidence_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration could not map % Question embeddings and % Question evidence rows', invalid_embedding_count, invalid_evidence_count;
	END IF;
END $$;--> statement-breakpoint
DELETE FROM "waxon_v2"."question_embeddings" AS "stale"
USING "waxon_v2"."question_embeddings" AS "retained"
WHERE "stale"."user_id" = "retained"."user_id"
	AND "stale"."question_id" = "retained"."question_id"
	AND "stale"."model" = "retained"."model"
	AND (
		"stale"."created_at" < "retained"."created_at"
		OR ("stale"."created_at" = "retained"."created_at" AND "stale".ctid < "retained".ctid)
	);--> statement-breakpoint
DELETE FROM "waxon_v2"."question_evidence" AS "stale"
USING "waxon_v2"."question_evidence" AS "retained"
WHERE "stale"."user_id" = "retained"."user_id"
	AND "stale"."question_id" = "retained"."question_id"
	AND "stale"."evidence_span_id" = "retained"."evidence_span_id"
	AND "stale"."requirement" = "retained"."requirement"
	AND "stale".ctid < "retained".ctid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" DROP CONSTRAINT IF EXISTS "question_embeddings_version_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" DROP CONSTRAINT IF EXISTS "question_embeddings_pk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" DROP CONSTRAINT IF EXISTS "question_evidence_version_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" DROP CONSTRAINT IF EXISTS "question_evidence_pk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" DROP COLUMN IF EXISTS "question_version_id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" DROP COLUMN IF EXISTS "question_version_id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" ADD CONSTRAINT "question_embeddings_pk" PRIMARY KEY("user_id","question_id","model");--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ADD CONSTRAINT "question_evidence_pk" PRIMARY KEY("user_id","question_id","evidence_span_id","requirement");--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_embeddings" ADD CONSTRAINT "question_embeddings_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_evidence" ADD CONSTRAINT "question_evidence_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD COLUMN IF NOT EXISTS "question_id" uuid;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD COLUMN IF NOT EXISTS "question_id" uuid;--> statement-breakpoint
UPDATE "waxon_v2"."evaluations" AS "evaluation"
SET "question_id" = "submission"."question_id"
FROM "waxon_v2"."answer_submissions" AS "submission"
WHERE "evaluation"."user_id" = "submission"."user_id"
	AND "evaluation"."submission_id" = "submission"."id"
	AND "evaluation"."question_id" IS NULL;--> statement-breakpoint
UPDATE "waxon_v2"."grade_events" AS "event"
SET "question_id" = "submission"."question_id"
FROM "waxon_v2"."answer_submissions" AS "submission"
WHERE "event"."user_id" = "submission"."user_id"
	AND "event"."submission_id" = "submission"."id"
	AND "event"."question_id" IS NULL;--> statement-breakpoint
DO $$
DECLARE
	invalid_evaluation_count bigint;
	invalid_grade_event_count bigint;
BEGIN
	SELECT count(*) INTO invalid_evaluation_count
	FROM "waxon_v2"."evaluations"
	WHERE "question_id" IS NULL;
	SELECT count(*) INTO invalid_grade_event_count
	FROM "waxon_v2"."grade_events"
	WHERE "question_id" IS NULL;
	IF invalid_evaluation_count > 0 OR invalid_grade_event_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration could not map % evaluations and % grade events to Questions', invalid_evaluation_count, invalid_grade_event_count;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" ADD CONSTRAINT "answer_submissions_user_id_id_question_id_unique" UNIQUE("user_id","id","question_id");--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" DROP CONSTRAINT IF EXISTS "evaluations_submission_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" DROP CONSTRAINT IF EXISTS "grade_events_submission_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD CONSTRAINT "evaluations_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD CONSTRAINT "grade_events_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" ADD CONSTRAINT "evaluations_submission_question_fk" FOREIGN KEY ("user_id","submission_id","question_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id","question_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waxon_v2"."grade_events" ADD CONSTRAINT "grade_events_submission_question_fk" FOREIGN KEY ("user_id","submission_id","question_id") REFERENCES "waxon_v2"."answer_submissions"("user_id","id","question_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP CONSTRAINT IF EXISTS "answer_submissions_version_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_search_embeddings" DROP CONSTRAINT IF EXISTS "question_search_embeddings_version_fk";--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP COLUMN IF EXISTS "question_version_id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_search_embeddings" DROP COLUMN IF EXISTS "question_version_id";--> statement-breakpoint
DROP TABLE IF EXISTS "waxon_v2"."question_versions";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" DROP COLUMN IF EXISTS "suspension_reason";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" DROP COLUMN IF EXISTS "deleted_at";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."answer_mode";--> statement-breakpoint
DO $$
DECLARE
	invalid_receipt_count bigint;
BEGIN
	SELECT count(*) INTO invalid_receipt_count
	FROM "waxon_v2"."mutation_receipts" AS "receipt"
	WHERE "receipt"."scope" IN ('library-add-questions', 'mcp-add-questions')
		AND (
			jsonb_typeof("receipt"."response" -> 'results') IS DISTINCT FROM 'array'
			OR jsonb_array_length(
				CASE
					WHEN jsonb_typeof("receipt"."response" -> 'results') = 'array'
					THEN "receipt"."response" -> 'results'
					ELSE '[]'::jsonb
				END
			) NOT BETWEEN 1 AND 50
			OR EXISTS (
				SELECT 1
				FROM jsonb_array_elements(
					CASE
						WHEN jsonb_typeof("receipt"."response" -> 'results') = 'array'
						THEN "receipt"."response" -> 'results'
						ELSE '[]'::jsonb
					END
				) AS "result"
				WHERE jsonb_typeof("result") IS DISTINCT FROM 'object'
					OR jsonb_typeof("result" -> 'id') IS DISTINCT FROM 'string'
					OR "result" ->> 'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
					OR NOT EXISTS (
						SELECT 1
						FROM "waxon_v2"."questions" AS "question"
						WHERE "question"."user_id" = "receipt"."user_id"
							AND "question"."id"::text = lower("result" ->> 'id')
					)
					OR jsonb_typeof("result" -> 'lifecycle') IS DISTINCT FROM 'string'
					OR "result" ->> 'lifecycle' NOT IN (
						'draft', 'new', 'learning', 'review', 'active', 'flagged',
						'paused', 'archived', 'suspended', 'trash', 'superseded'
					)
			)
		);
	IF invalid_receipt_count > 0 THEN
		RAISE EXCEPTION 'Issue #18 contract migration found % add receipts with invalid public result data', invalid_receipt_count;
	END IF;
END $$;--> statement-breakpoint
UPDATE "waxon_v2"."mutation_receipts" AS "receipt"
SET "response" = jsonb_set(
	"receipt"."response",
	'{results}',
	(
		SELECT coalesce(jsonb_agg(
			"result" || jsonb_build_object(
				'lifecycle', CASE
					WHEN "result" ->> 'lifecycle' IN ('new', 'learning', 'review', 'active') THEN 'active'
					WHEN "result" ->> 'lifecycle' = 'flagged' THEN 'flagged'
					WHEN "result" ->> 'lifecycle' IN ('draft', 'paused', 'archived', 'suspended', 'trash', 'superseded') THEN 'archived'
					ELSE "result" ->> 'lifecycle'
				END,
				'flags', CASE
					WHEN jsonb_typeof("result" -> 'flags') = 'array' THEN "result" -> 'flags'
					ELSE '[]'::jsonb
				END,
				'answerStandardConflict', CASE
					WHEN jsonb_typeof("result" -> 'answerStandardConflict') = 'boolean'
					THEN "result" -> 'answerStandardConflict'
					ELSE 'false'::jsonb
				END
			)
			ORDER BY "ordinality"
		), '[]'::jsonb)
		FROM jsonb_array_elements("receipt"."response" -> 'results')
			WITH ORDINALITY AS "items"("result", "ordinality")
	),
	false
)
WHERE "receipt"."scope" IN ('library-add-questions', 'mcp-add-questions');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_search_idx" ON "waxon_v2"."questions" USING gin ((
	setweight(to_tsvector('simple', coalesce("prompt", '')), 'A') ||
	setweight(to_tsvector('simple', coalesce("reference_answer", '')), 'B')
));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_prompt_trgm_idx" ON "waxon_v2"."questions" USING gist ("prompt" gist_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "questions_active_target_unique" ON "waxon_v2"."questions" USING btree ("user_id","target_key") WHERE "lifecycle" = 'active';
