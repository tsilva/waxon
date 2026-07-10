DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "course_page_attempts") THEN
    RAISE EXCEPTION 'course_page_attempts must be empty before retiring legacy course pages';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "course_pages" legacy_page
    WHERE legacy_page."question_id" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "questions" question
         WHERE question."id" = legacy_page."question_id"
           AND question."user_id" = (
             SELECT course."user_id"
             FROM "courses" course
             WHERE course."id" = legacy_page."course_id"
           )
       )
  ) THEN
    RAISE EXCEPTION 'every legacy course page must have a same-user question before conversion';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "course_pages" legacy_page
    INNER JOIN "course_chat_messages" message
      ON message."course_id" = legacy_page."course_id"
  ) THEN
    RAISE EXCEPTION 'legacy course pages cannot be merged into an existing transcript automatically';
  END IF;
END $$;--> statement-breakpoint

UPDATE "questions" question
SET "concise_answer" = legacy_page."correct_answer",
    "updated_at" = GREATEST(question."updated_at", legacy_page."updated_at")
FROM "course_pages" legacy_page
WHERE question."id" = legacy_page."question_id"
  AND length(trim(question."concise_answer")) = 0
  AND length(trim(legacy_page."correct_answer")) > 0;--> statement-breakpoint

INSERT INTO "course_chat_messages" (
  "course_id",
  "role",
  "content",
  "tool_calls",
  "sequence",
  "created_at",
  "updated_at"
)
SELECT
  legacy_page."course_id",
  'assistant',
  legacy_page."body",
  jsonb_build_array(
    jsonb_build_object(
      'id', 'legacy-page-' || legacy_page."id"::text,
      'type', 'function',
      'function', jsonb_build_object(
        'name', 'render_question_widget',
        'arguments', jsonb_build_object(
          'type', CASE
            WHEN jsonb_typeof(legacy_page."choices") = 'array'
              AND jsonb_array_length(legacy_page."choices") >= 2
              THEN 'multiple_choice'
            ELSE 'free_text'
          END,
          'id', 'legacy-page-' || legacy_page."id"::text,
          'question', legacy_page."question",
          'choices', CASE
            WHEN jsonb_typeof(legacy_page."choices") = 'array'
              THEN legacy_page."choices"
            ELSE '[]'::jsonb
          END
        )
      )
    )
  ),
  row_number() OVER (
    PARTITION BY legacy_page."course_id"
    ORDER BY legacy_page."chapter_index", legacy_page."page_index", legacy_page."id"
  )::integer - 1,
  legacy_page."created_at",
  legacy_page."updated_at"
FROM "course_pages" legacy_page
ORDER BY legacy_page."course_id", legacy_page."chapter_index", legacy_page."page_index";--> statement-breakpoint

WITH flattened AS (
  SELECT
    course."id",
    COALESCE((
      SELECT jsonb_agg(page.value ORDER BY chapter.ordinality, page.ordinality)
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(course."toc"->'chapters') = 'array'
            THEN course."toc"->'chapters'
          ELSE '[]'::jsonb
        END
      )
        WITH ORDINALITY AS chapter(value, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(chapter.value->'pages') = 'array'
            THEN chapter.value->'pages'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS page(value, ordinality)
    ), '[]'::jsonb) AS pages,
    course."current_page_index" + COALESCE((
      SELECT sum(
        CASE
          WHEN jsonb_typeof(chapter.value->'pages') = 'array'
            THEN jsonb_array_length(chapter.value->'pages')
          ELSE 0
        END
      )::integer
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(course."toc"->'chapters') = 'array'
            THEN course."toc"->'chapters'
          ELSE '[]'::jsonb
        END
      )
        WITH ORDINALITY AS chapter(value, ordinality)
      WHERE chapter.ordinality <= course."current_chapter_index"
    ), 0) AS page_index
  FROM "courses" course
  WHERE jsonb_typeof(course."toc"->'chapters') = 'array'
    AND jsonb_typeof(course."toc"->'pages') IS DISTINCT FROM 'array'
)
UPDATE "courses" course
SET "toc" = jsonb_set(course."toc" - 'chapters', '{pages}', flattened.pages, true),
    "current_page_index" = flattened.page_index
FROM flattened
WHERE course."id" = flattened."id";--> statement-breakpoint

DROP TABLE "course_page_attempts";--> statement-breakpoint
DROP TABLE "course_pages";--> statement-breakpoint
ALTER TABLE "courses" DROP COLUMN "current_chapter_index";
