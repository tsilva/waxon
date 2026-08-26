DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_type
		JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
		WHERE pg_namespace.nspname = 'waxon_v2'
		  AND pg_type.typname = 'question_flag_origin'
	) THEN
		CREATE TYPE "waxon_v2"."question_flag_origin" AS ENUM('waxon_validation', 'learner');
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waxon_v2"."question_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"origin" "waxon_v2"."question_flag_origin" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "question_flags_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_flags_question_created_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_flags_unresolved_idx" ON "waxon_v2"."question_flags" USING btree ("user_id","question_id") WHERE "waxon_v2"."question_flags"."resolved_at" IS NULL;--> statement-breakpoint
DROP TABLE IF EXISTS "waxon_v2"."retry_obligations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "waxon_v2"."review_session_items" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "waxon_v2"."review_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP CONSTRAINT IF EXISTS "answer_submissions_item_unique";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'waxon_v2'
		  AND table_name = 'learner_settings'
		  AND column_name = 'daily_minutes'
	) THEN
		UPDATE "waxon_v2"."learner_settings" SET "timezone" = NULL WHERE "timezone" = 'UTC';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ADD COLUMN IF NOT EXISTS "due_on" date;--> statement-breakpoint
UPDATE "waxon_v2"."memory_states" AS "memory"
SET "due_on" = (
	"memory"."due_at" AT TIME ZONE COALESCE(
		(SELECT "timezone" FROM "waxon_v2"."learner_settings" AS "settings"
		 WHERE "settings"."user_id" = "memory"."user_id"
		   AND "settings"."timezone" IN (SELECT "name" FROM pg_timezone_names)),
		'UTC'
	)
)::date
WHERE "memory"."due_on" IS NULL;--> statement-breakpoint
ALTER TABLE "waxon_v2"."memory_states" ALTER COLUMN "due_on" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'waxon_v2'
		  AND table_name = 'questions'
		  AND column_name = 'creation_order'
	) THEN
		ALTER TABLE "waxon_v2"."questions" ADD COLUMN "creation_order" bigserial;
	END IF;
END $$;--> statement-breakpoint
WITH ordered_questions AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id")::bigint AS "position"
	FROM "waxon_v2"."questions"
)
UPDATE "waxon_v2"."questions" AS "question"
SET "creation_order" = ordered_questions."position"
FROM ordered_questions
WHERE "question"."id" = ordered_questions."id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" ALTER COLUMN "creation_order" SET NOT NULL;--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('waxon_v2.questions', 'creation_order'),
	GREATEST(COALESCE((SELECT max("creation_order") FROM "waxon_v2"."questions"), 0), 1),
	EXISTS (SELECT 1 FROM "waxon_v2"."questions")
);--> statement-breakpoint
DROP INDEX IF EXISTS "waxon_v2"."memory_states_due_idx";--> statement-breakpoint
CREATE INDEX "memory_states_due_idx" ON "waxon_v2"."memory_states" USING btree ("user_id","due_on");--> statement-breakpoint
ALTER TABLE "waxon_v2"."answer_submissions" DROP COLUMN IF EXISTS "session_item_id";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN IF EXISTS "daily_minutes";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN IF EXISTS "desired_retention";--> statement-breakpoint
ALTER TABLE "waxon_v2"."learner_settings" DROP COLUMN IF EXISTS "new_items_per_day";--> statement-breakpoint
ALTER TABLE "waxon_v2"."questions" DROP COLUMN IF EXISTS "importance";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."retry_status";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."session_item_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."session_item_state";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."session_kind";--> statement-breakpoint
DROP TYPE IF EXISTS "waxon_v2"."session_status";
