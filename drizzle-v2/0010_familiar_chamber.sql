DROP INDEX "waxon_v2"."questions_active_target_unique";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DATA TYPE text USING "lifecycle"::text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DEFAULT 'new'::text;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "prior_lifecycle" SET DATA TYPE text USING "prior_lifecycle"::text;--> statement-breakpoint
UPDATE "waxon_v2"."questions"
SET "lifecycle" = CASE
	WHEN "lifecycle" IN ('draft', 'suspended') THEN 'paused'
	WHEN "lifecycle" = 'superseded' THEN 'archived'
	ELSE "lifecycle"
END,
"prior_lifecycle" = CASE
	WHEN "prior_lifecycle" IN ('draft', 'suspended') THEN 'paused'
	WHEN "prior_lifecycle" = 'superseded' THEN 'archived'
	ELSE "prior_lifecycle"
END;--> statement-breakpoint
UPDATE "waxon_v2"."jobs"
SET "status" = 'cancelled',
	"error" = 'Retired by the Lean Waxon migration.',
	"updated_at" = now()
WHERE "type" <> 'evaluate_submission'
	AND "status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_versions" ALTER COLUMN "target_text" SET DEFAULT '';--> statement-breakpoint
DROP TYPE "waxon_v2"."question_lifecycle";--> statement-breakpoint
CREATE TYPE "waxon_v2"."question_lifecycle" AS ENUM('new', 'learning', 'review', 'paused', 'archived', 'trash');--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DEFAULT 'new'::"waxon_v2"."question_lifecycle";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "lifecycle" SET DATA TYPE "waxon_v2"."question_lifecycle" USING "lifecycle"::"waxon_v2"."question_lifecycle";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "prior_lifecycle" SET DATA TYPE "waxon_v2"."question_lifecycle" USING "prior_lifecycle"::"waxon_v2"."question_lifecycle";
--> statement-breakpoint
CREATE UNIQUE INDEX "questions_active_target_unique" ON "waxon_v2"."questions" USING btree ("user_id","target_key") WHERE "waxon_v2"."questions"."lifecycle" IN ('new', 'learning', 'review');
