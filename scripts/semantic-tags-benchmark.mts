import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { activeEmbeddingSpace } from "../app/lib/v2/embeddingSpaces.ts";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and keyenv can provide configuration without local env files.
  }
}

function flag(name: string): string | null {
  const value = process.argv.find((item) => item.startsWith(`${name}=`));
  return value?.slice(name.length + 1) ?? null;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

const userId = flag("--user-id")?.trim();
if (!userId) {
  throw new Error(
    "A learner is required: pnpm semantic-tags:benchmark -- --user-id=<id>",
  );
}
const iterations = Math.max(
  5,
  Math.min(500, Math.trunc(Number(flag("--iterations") ?? 50)) || 50),
);
const explain = process.argv.includes("--explain");
const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const space = activeEmbeddingSpace();
const pool = new Pool({ connectionString });
const questionTimes: number[] = [];
const tagTimes: number[] = [];
const questionDatabaseTimes: number[] = [];
const tagDatabaseTimes: number[] = [];

function executionTime(result: { rows: Array<Record<string, unknown>> }): number {
  const plan = result.rows[0]?.["QUERY PLAN"] as
    | Array<{ "Execution Time"?: unknown }>
    | undefined;
  const value = plan?.[0]?.["Execution Time"];
  if (typeof value !== "number") {
    throw new Error("PostgreSQL did not return an execution time.");
  }
  return value;
}

const relatedQuestionsSql = `
  WITH selected_tag AS (
    SELECT tag.id, embedding.embedding,
           ARRAY(
             SELECT phraseto_tsquery('simple', term.value)
               FROM unnest(array_prepend(tag.label, tag.aliases)) AS term(value)
           ) AS lexical_queries
      FROM waxon_v2.tag_embeddings embedding
      JOIN waxon_v2.tags tag
        ON tag.user_id = embedding.user_id AND tag.id = embedding.tag_id
     WHERE embedding.user_id = $1
       AND embedding.space_id = $2
       AND embedding.tag_id = $3
       AND tag.deleted_at IS NULL
  ), ranked AS (
    SELECT question_embedding.question_id,
           question_embedding.embedding <=> selected_tag.embedding AS distance,
           CASE WHEN to_tsvector('simple', question.prompt)
                          @@ ANY(selected_tag.lexical_queries)
                     AND (question_embedding.embedding <=> selected_tag.embedding) <= 0.6
           THEN 0 ELSE 1 END AS lexical_tier
      FROM waxon_v2.question_embeddings question_embedding
      JOIN waxon_v2.questions question
        ON question.user_id = question_embedding.user_id
       AND question.id = question_embedding.question_id
      CROSS JOIN selected_tag
     WHERE question_embedding.user_id = $1
       AND question_embedding.space_id = $2
       AND question.lifecycle::text IN ('active', 'flagged', 'archived')
  )
  SELECT question_id, distance
    FROM ranked
   ORDER BY lexical_tier, distance, question_id
   LIMIT 50`;

const relatedTagsSql = `
  WITH selected_questions AS (
    SELECT embedding.question_id, embedding.embedding,
           to_tsvector('simple', question.prompt) AS prompt_document
      FROM waxon_v2.question_embeddings embedding
      JOIN waxon_v2.questions question
        ON question.user_id = embedding.user_id
       AND question.id = embedding.question_id
     WHERE embedding.user_id = $1 AND embedding.space_id = $2
     ORDER BY embedding.question_id
     LIMIT 50
  ), active_tags AS MATERIALIZED (
    SELECT tag.id, embedding.embedding,
           ARRAY(
             SELECT phraseto_tsquery('simple', term.value)
               FROM unnest(array_prepend(tag.label, tag.aliases)) AS term(value)
           ) AS lexical_queries
      FROM waxon_v2.tag_embeddings embedding
      JOIN waxon_v2.tags tag
        ON tag.user_id = embedding.user_id AND tag.id = embedding.tag_id
     WHERE embedding.user_id = $1
       AND embedding.space_id = $2
       AND tag.deleted_at IS NULL
  )
  SELECT selected.question_id, nearest.tag_id
    FROM selected_questions selected
    CROSS JOIN LATERAL (
      SELECT scored.tag_id, scored.distance, scored.lexical_match
        FROM (
          SELECT tag.id AS tag_id,
                 tag.embedding <=> selected.embedding AS distance,
                 selected.prompt_document @@ ANY(tag.lexical_queries)
                   AS lexical_match
            FROM active_tags tag
        ) scored
       WHERE scored.distance <= 0.48
          OR (scored.lexical_match AND scored.distance <= 0.6)
       ORDER BY scored.lexical_match DESC, scored.distance, scored.tag_id
       LIMIT 3
    ) nearest
   ORDER BY selected.question_id, nearest.lexical_match DESC,
            nearest.distance, nearest.tag_id`;

const scaledRelatedTagsSql = `
  WITH selected_questions AS (
    SELECT embedding.question_id, embedding.embedding,
           to_tsvector('simple', question.prompt) AS prompt_document
      FROM waxon_v2.question_embeddings embedding
      JOIN waxon_v2.questions question
        ON question.user_id = embedding.user_id
       AND question.id = embedding.question_id
     WHERE embedding.user_id = $1 AND embedding.space_id = $2
     ORDER BY embedding.question_id
     LIMIT 50
  ), source_tags AS MATERIALIZED (
    SELECT tag.id, embedding.embedding,
           ARRAY(
             SELECT phraseto_tsquery('simple', term.value)
               FROM unnest(array_prepend(tag.label, tag.aliases)) AS term(value)
           ) AS lexical_queries,
           row_number() OVER (ORDER BY tag.id) AS ordinal,
           count(*) OVER () AS source_count
      FROM waxon_v2.tag_embeddings embedding
      JOIN waxon_v2.tags tag
        ON tag.user_id = embedding.user_id AND tag.id = embedding.tag_id
     WHERE embedding.user_id = $1 AND embedding.space_id = $2
       AND tag.deleted_at IS NULL
  ), scaled_tags AS MATERIALIZED (
    SELECT source.id, source.embedding, source.lexical_queries,
           generated.value
      FROM generate_series(1, $3::int) generated(value)
      JOIN source_tags source
        ON source.ordinal = ((generated.value - 1) % source.source_count) + 1
  )
  SELECT selected.question_id, nearest.id
    FROM selected_questions selected
    CROSS JOIN LATERAL (
      SELECT tag.id, tag.value,
             tag.embedding <=> selected.embedding AS distance,
             selected.prompt_document @@ ANY(tag.lexical_queries)
               AS lexical_match
        FROM scaled_tags tag
       ORDER BY lexical_match DESC, distance, tag.value
       LIMIT 3
    ) nearest`;

try {
  const [counts, tagSample] = await Promise.all([
    pool.query<{ questions: string; tags: string }>(
      `SELECT
         (SELECT count(*)::text FROM waxon_v2.question_embeddings
           WHERE user_id = $1 AND space_id = $2) AS questions,
         (SELECT count(*)::text FROM waxon_v2.tag_embeddings embedding
            JOIN waxon_v2.tags tag
              ON tag.user_id = embedding.user_id AND tag.id = embedding.tag_id
           WHERE embedding.user_id = $1 AND embedding.space_id = $2
             AND tag.deleted_at IS NULL) AS tags`,
      [userId, space.id],
    ),
    pool.query<{ tag_id: string }>(
      `SELECT embedding.tag_id
         FROM waxon_v2.tag_embeddings embedding
         JOIN waxon_v2.tags tag
           ON tag.user_id = embedding.user_id AND tag.id = embedding.tag_id
        WHERE embedding.user_id = $1 AND embedding.space_id = $2
          AND tag.deleted_at IS NULL
        ORDER BY embedding.tag_id
        LIMIT 1`,
      [userId, space.id],
    ),
  ]);
  const tagId = tagSample.rows[0]?.tag_id;
  if (!tagId) throw new Error("The selected learner has no active embedded Tags.");

  for (let index = 0; index < iterations; index += 1) {
    let startedAt = performance.now();
    await pool.query(relatedQuestionsSql, [userId, space.id, tagId]);
    questionTimes.push(performance.now() - startedAt);
    questionDatabaseTimes.push(
      executionTime(
        await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${relatedQuestionsSql}`,
          [userId, space.id, tagId],
        ),
      ),
    );

    startedAt = performance.now();
    await pool.query(relatedTagsSql, [userId, space.id]);
    tagTimes.push(performance.now() - startedAt);
    tagDatabaseTimes.push(
      executionTime(
        await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${relatedTagsSql}`,
          [userId, space.id],
        ),
      ),
    );
  }

  const scaledTagMeasurements = [];
  for (const tagScale of [5_000, 10_000]) {
    const times: number[] = [];
    const databaseTimes: number[] = [];
    for (let index = 0; index < Math.min(iterations, 10); index += 1) {
      const startedAt = performance.now();
      await pool.query(scaledRelatedTagsSql, [userId, space.id, tagScale]);
      times.push(performance.now() - startedAt);
      databaseTimes.push(
        executionTime(
          await pool.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scaledRelatedTagsSql}`,
            [userId, space.id, tagScale],
          ),
        ),
      );
    }
    scaledTagMeasurements.push({
      tags: tagScale,
      iterations: times.length,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      databaseP50Ms: percentile(databaseTimes, 0.5),
      databaseP95Ms: percentile(databaseTimes, 0.95),
      releaseGate: false,
    });
  }

  if (explain) {
    const [questionPlan, tagPlan] = await Promise.all([
      pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${relatedQuestionsSql}`, [
        userId,
        space.id,
        tagId,
      ]),
      pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${relatedTagsSql}`, [
        userId,
        space.id,
      ]),
    ]);
    console.log(JSON.stringify({
      relatedQuestionsPlan: questionPlan.rows[0],
      relatedTagsPlan: tagPlan.rows[0],
    }, null, 2));
  }

  const relatedQuestionsP95 = percentile(questionDatabaseTimes, 0.95);
  const relatedTagsP95 = percentile(tagDatabaseTimes, 0.95);
  const embeddedQuestions = Number(counts.rows[0]?.questions ?? 0);
  const embeddedTags = Number(counts.rows[0]?.tags ?? 0);
  const representative = embeddedQuestions >= 5_000 && embeddedTags >= 1_000;
  const output = {
    userId,
    space: space.key,
    embeddedQuestions,
    embeddedTags,
    representative,
    iterations,
    relatedQuestions: {
      p50Ms: percentile(questionTimes, 0.5),
      p95Ms: percentile(questionTimes, 0.95),
      databaseP50Ms: percentile(questionDatabaseTimes, 0.5),
      databaseP95Ms: relatedQuestionsP95,
      targetMs: 100,
      passes: relatedQuestionsP95 < 100,
    },
    relatedTagsForPage: {
      p50Ms: percentile(tagTimes, 0.5),
      p95Ms: percentile(tagTimes, 0.95),
      databaseP50Ms: percentile(tagDatabaseTimes, 0.5),
      databaseP95Ms: relatedTagsP95,
      targetMs: 200,
      passes: relatedTagsP95 < 200,
    },
    scaledTagMeasurements,
  };
  console.log(JSON.stringify(output, null, 2));
  if (representative &&
      (!output.relatedQuestions.passes || !output.relatedTagsForPage.passes)) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
