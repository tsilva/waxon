ALTER TABLE "question_embeddings" ADD COLUMN "projection_x" double precision;
ALTER TABLE "question_embeddings" ADD COLUMN "projection_y" double precision;

WITH projected AS (
  SELECT
    question_embeddings.id,
    sum(
      component.value::double precision *
      (
        sin(component.ordinality::double precision * 1.37) +
        cos(component.ordinality::double precision * 2.11)
      )
    ) / sqrt(count(*)::double precision) AS projection_x,
    sum(
      component.value::double precision *
      (
        sin(component.ordinality::double precision * 2.73) -
        cos(component.ordinality::double precision * 0.97)
      )
    ) / sqrt(count(*)::double precision) AS projection_y
  FROM "question_embeddings" question_embeddings
  CROSS JOIN LATERAL regexp_split_to_table(
    trim(both '[]' from question_embeddings.embedding::text),
    ','
  ) WITH ORDINALITY AS component(value, ordinality)
  GROUP BY question_embeddings.id
)
UPDATE "question_embeddings"
SET
  "projection_x" = projected.projection_x,
  "projection_y" = projected.projection_y
FROM projected
WHERE "question_embeddings"."id" = projected.id;

ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_projection_pair_check" CHECK (
  (
    "projection_x" IS NULL
    AND "projection_y" IS NULL
  )
  OR (
    "projection_x" IS NOT NULL
    AND "projection_y" IS NOT NULL
    AND "projection_x"::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND "projection_y"::text NOT IN ('NaN', 'Infinity', '-Infinity')
  )
);
