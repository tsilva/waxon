ALTER TABLE "waxon_v2"."retry_obligations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_session_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "waxon_v2"."retry_obligations" CASCADE;--> statement-breakpoint
DROP TABLE "waxon_v2"."review_session_items" CASCADE;--> statement-breakpoint
DROP TABLE "waxon_v2"."review_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP CONSTRAINT "answer_submissions_item_unique";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
UPDATE "waxon_v2"."learner_settings" SET "timezone" = NULL WHERE "timezone" = 'UTC';--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ADD COLUMN "due_on" date;--> statement-breakpoint
UPDATE "waxon_v2"."memory_states" AS "memory"
SET "due_on" = (
	"memory"."due_at" AT TIME ZONE COALESCE(
		(SELECT "timezone" FROM "waxon_v2"."learner_settings" AS "settings"
		 WHERE "settings"."user_id" = "memory"."user_id"
		   AND "settings"."timezone" IN (SELECT "name" FROM pg_timezone_names)),
		'UTC'
	)
)::date;--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ALTER COLUMN "due_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ADD COLUMN "creation_order" bigserial NOT NULL;--> statement-breakpoint
WITH ordered_questions AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id")::bigint AS "position"
	FROM "waxon_v2"."questions"
)
UPDATE "waxon_v2"."questions" AS "question"
SET "creation_order" = ordered_questions."position"
FROM ordered_questions
WHERE "question"."id" = ordered_questions."id";--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('waxon_v2.questions', 'creation_order'),
	GREATEST(COALESCE((SELECT max("creation_order") FROM "waxon_v2"."questions"), 0), 1),
	EXISTS (SELECT 1 FROM "waxon_v2"."questions")
);--> statement-breakpoint
DROP INDEX "waxon_v2"."memory_states_due_idx";--> statement-breakpoint
CREATE INDEX "memory_states_due_idx" ON "waxon_v2"."memory_states" USING btree ("user_id","due_on");--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP COLUMN "session_item_id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN "daily_minutes";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN "desired_retention";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN "new_items_per_day";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" DROP COLUMN "importance";--> statement-breakpoint
DROP TYPE "waxon_v2"."retry_status";--> statement-breakpoint
DROP TYPE "waxon_v2"."session_item_kind";--> statement-breakpoint
DROP TYPE "waxon_v2"."session_item_state";--> statement-breakpoint
DROP TYPE "waxon_v2"."session_kind";--> statement-breakpoint
DROP TYPE "waxon_v2"."session_status";
