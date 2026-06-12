CREATE TABLE IF NOT EXISTS "concept_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "slug" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "embedding" vector(3072),
  "created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  "updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  CONSTRAINT "concept_tags_slug_nonempty_check" CHECK (length(trim("slug")) > 0),
  CONSTRAINT "concept_tags_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "concept_tags_created_at_check" CHECK ("created_at" >= 0),
  CONSTRAINT "concept_tags_updated_at_check" CHECK ("updated_at" >= "created_at")
);

CREATE TABLE IF NOT EXISTS "question_concept_tags" (
  "question_id" uuid NOT NULL,
  "concept_tag_id" uuid NOT NULL,
  "created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
  CONSTRAINT "question_concept_tags_pkey" PRIMARY KEY("question_id","concept_tag_id"),
  CONSTRAINT "question_concept_tags_created_at_check" CHECK ("created_at" >= 0)
);

ALTER TABLE "concept_tags" ADD CONSTRAINT "concept_tags_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "question_concept_tags" ADD CONSTRAINT "question_concept_tags_question_id_questions_id_fk"
  FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "question_concept_tags" ADD CONSTRAINT "question_concept_tags_concept_tag_id_concept_tags_id_fk"
  FOREIGN KEY ("concept_tag_id") REFERENCES "public"."concept_tags"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "concept_tags_user_slug_idx"
  ON "concept_tags" USING btree ("user_id", "slug");

CREATE INDEX IF NOT EXISTS "concept_tags_user_active_idx"
  ON "concept_tags" USING btree ("user_id", "active");

CREATE INDEX IF NOT EXISTS "question_concept_tags_tag_question_idx"
  ON "question_concept_tags" USING btree ("concept_tag_id", "question_id");

WITH deck_concepts AS (
  INSERT INTO "concept_tags" ("user_id", "slug", "active", "created_at", "updated_at")
  SELECT DISTINCT
    decks.user_id,
    coalesce(nullif(lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(unaccent(decks.name), '[^A-Za-z0-9]+', '-', 'g'),
          '(^-+|-+$)',
          '',
          'g'
        ),
        '-+',
        '-',
        'g'
      )
    ), ''), 'untitled-deck') AS slug,
    true,
    min(decks.created_at),
    max(decks.updated_at)
  FROM "decks" decks
  GROUP BY decks.user_id, decks.name
  ON CONFLICT ("user_id", "slug") DO UPDATE SET
    updated_at = greatest("concept_tags"."updated_at", excluded.updated_at)
  RETURNING id, user_id, slug
),
all_deck_concepts AS (
  SELECT id, user_id, slug FROM deck_concepts
  UNION
  SELECT concept_tags.id, concept_tags.user_id, concept_tags.slug
  FROM "concept_tags" concept_tags
)
INSERT INTO "question_concept_tags" ("question_id", "concept_tag_id", "created_at")
SELECT
  questions.id,
  all_deck_concepts.id,
  questions.created_at
FROM "questions" questions
INNER JOIN "decks" decks ON decks.id = questions.deck_id
INNER JOIN all_deck_concepts
  ON all_deck_concepts.user_id = decks.user_id
 AND all_deck_concepts.slug = coalesce(nullif(lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(unaccent(decks.name), '[^A-Za-z0-9]+', '-', 'g'),
          '(^-+|-+$)',
          '',
          'g'
        ),
        '-+',
        '-',
        'g'
      )
    ), ''), 'untitled-deck')
ON CONFLICT DO NOTHING;
