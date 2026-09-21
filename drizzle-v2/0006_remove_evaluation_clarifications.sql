-- Remove the optional note appended by the former feedback composer.
UPDATE "waxon_v2"."evaluations"
SET "feedback" = split_part(
  "feedback",
  ' Additional note (this did not change your result): ',
  1
)
WHERE "clarifications" <> '[]'::jsonb
  AND strpos("feedback", ' Additional note (this did not change your result): ') > 0;
--> statement-breakpoint
ALTER TABLE "waxon_v2"."evaluations" DROP COLUMN "clarifications";
