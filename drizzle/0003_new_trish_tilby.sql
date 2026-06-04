CREATE EXTENSION IF NOT EXISTS "unaccent";--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "question_slug" text;--> statement-breakpoint
UPDATE "questions"
SET "question_slug" = nullif(
	trim(
		both '-' from regexp_replace(
			regexp_replace(lower(unaccent("question")), '[^[:ascii:]]', '', 'g'),
			'[^a-z0-9]+',
			'-',
			'g'
		)
	),
	''
);--> statement-breakpoint
UPDATE "questions"
SET "question_slug" = 'question-' || substr(md5("question"), 1, 16)
WHERE "question_slug" IS NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "question_slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "questions_question_slug_idx" ON "questions" USING btree ("question_slug");
