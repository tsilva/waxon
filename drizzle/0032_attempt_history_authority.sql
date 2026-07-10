INSERT INTO "question_attempts" (
  "user_id",
  "question_id",
  "question",
  "raw_answer",
  "answer_summary",
  "score",
  "justification",
  "submitted_at",
  "resolved_at"
)
SELECT
  question."user_id",
  question."id",
  question."question",
  '',
  '',
  split_part(legacy_review.entry, ':', 2)::integer,
  'Imported from legacy review history.',
  split_part(legacy_review.entry, ':', 1)::bigint,
  split_part(legacy_review.entry, ':', 1)::bigint
FROM "questions" question
CROSS JOIN LATERAL regexp_split_to_table(question."reviews", '\|') AS legacy_review(entry)
WHERE length(question."reviews") > 0
  AND NOT EXISTS (
    SELECT 1
    FROM "question_attempts" attempt
    WHERE attempt."question_id" = question."id"
      AND attempt."resolved_at" = split_part(legacy_review.entry, ':', 1)::bigint
      AND attempt."score" = split_part(legacy_review.entry, ':', 2)::integer
  );--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "questions" question
    CROSS JOIN LATERAL regexp_split_to_table(question."reviews", '\|') AS legacy_review(entry)
    WHERE length(question."reviews") > 0
      AND NOT EXISTS (
        SELECT 1
        FROM "question_attempts" attempt
        WHERE attempt."question_id" = question."id"
          AND attempt."resolved_at" = split_part(legacy_review.entry, ':', 1)::bigint
          AND attempt."score" = split_part(legacy_review.entry, ':', 2)::integer
      )
  ) THEN
    RAISE EXCEPTION 'legacy review history backfill is incomplete';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "questions" DROP COLUMN "reviews";
