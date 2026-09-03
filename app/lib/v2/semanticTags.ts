import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { getV2Client } from "../../db/v2/client.ts";
import { activeEmbeddingSpace } from "./embeddingSpaces.ts";
import type { V2QuestionLifecycle, V2TagRef } from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RELATED_QUESTIONS = 50;
export const MAX_RELATED_TAGS = 3;
export const MIN_RELATED_TAG_SIMILARITY = 0.51;
export const MIN_LEXICAL_RESCUE_SIMILARITY = 0.4;
const MAX_RELATED_TAG_DISTANCE = 1 - MIN_RELATED_TAG_SIMILARITY;
const MAX_LEXICAL_RESCUE_DISTANCE = 1 - MIN_LEXICAL_RESCUE_SIMILARITY;
const MAX_SELECTED_TAGS = 10;
const HYBRID_RANKING_KEY = "hybrid-lexical-semantic-v1";

type SemanticCursor = {
  rankingKey: string;
  spaceKey: string;
  fingerprint: string;
  lexicalTier: 0 | 1;
  distance: number;
  questionId: string;
};

function queryFingerprint(input: {
  spaceKey: string;
  tagIds: readonly string[];
  lifecycle: V2QuestionLifecycle | null;
  text: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        rankingKey: HYBRID_RANKING_KEY,
        spaceKey: input.spaceKey,
        tagIds: [...input.tagIds].sort(),
        lifecycle: input.lifecycle,
        text: input.text,
      }),
    )
    .digest("base64url");
}

function parseCursor(
  value: string | undefined,
  expected: { spaceKey: string; fingerprint: string },
): SemanticCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SemanticCursor>;
    if (
      parsed.rankingKey !== HYBRID_RANKING_KEY ||
      parsed.spaceKey !== expected.spaceKey ||
      parsed.fingerprint !== expected.fingerprint ||
      (parsed.lexicalTier !== 0 && parsed.lexicalTier !== 1) ||
      typeof parsed.distance !== "number" ||
      !Number.isFinite(parsed.distance) ||
      typeof parsed.questionId !== "string" ||
      !UUID_PATTERN.test(parsed.questionId)
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as SemanticCursor;
  } catch {
    throw new Error("The Library cursor is invalid for this semantic view.");
  }
}

function encodeCursor(cursor: SemanticCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function relatedTags(input: {
  learnerId: string;
  questionIds: readonly string[];
  limit?: number;
}): Promise<Map<string, V2TagRef[]>> {
  const questionIds = [...new Set(input.questionIds)];
  if (questionIds.length > MAX_RELATED_QUESTIONS) {
    throw new Error("Related Tags can be loaded for at most 50 Questions.");
  }
  if (questionIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new Error("Question IDs must be valid.");
  }
  const output = new Map(questionIds.map((id) => [id, [] as V2TagRef[]]));
  if (questionIds.length === 0) return output;
  const limit = Math.max(
    1,
    Math.min(MAX_RELATED_TAGS, input.limit ?? MAX_RELATED_TAGS),
  );
  const space = activeEmbeddingSpace();

  return Sentry.startSpan(
    {
      name: "semantic_tags.related_tags",
      op: "db.query",
      attributes: {
        "embedding.space": space.key,
        "semantic.question_count": questionIds.length,
        "semantic.minimum_similarity": MIN_RELATED_TAG_SIMILARITY,
        "semantic.lexical_rescue_minimum_similarity":
          MIN_LEXICAL_RESCUE_SIMILARITY,
      },
    },
    async (span) => {
      const result = await getV2Client().pool.query<{
        question_id: string;
        tag_id: string | null;
        label: string | null;
        lexical_priority: boolean | null;
        lexical_rescue: boolean | null;
        has_embedding: boolean;
        tag_count: number | string;
        lexical_match_count: number | string;
        rejected_literal_match_count: number | string;
      }>(
        `WITH selected_questions AS (
           SELECT input.question_id,
                  to_tsvector('simple', question.prompt) AS prompt_document,
                  embedding.embedding
             FROM unnest($3::uuid[]) AS input(question_id)
             JOIN waxon_v2.questions question
               ON question.user_id = $1 AND question.id = input.question_id
             LEFT JOIN waxon_v2.question_embeddings embedding
               ON embedding.user_id = question.user_id
              AND embedding.question_id = question.id
              AND embedding.space_id = $2
         ), active_tags AS MATERIALIZED (
           SELECT tag.id, tag.label, embedding.embedding,
                  ARRAY(
                    SELECT phraseto_tsquery('simple', term.value)
                      FROM unnest(array_prepend(tag.label, tag.aliases))
                           AS term(value)
                  ) AS lexical_queries
             FROM waxon_v2.tag_embeddings embedding
             JOIN waxon_v2.tags tag
               ON tag.user_id = embedding.user_id
              AND tag.id = embedding.tag_id
            WHERE embedding.user_id = $1
              AND embedding.space_id = $2
              AND tag.deleted_at IS NULL
         )
         SELECT selected.question_id, nearest.tag_id, nearest.label,
                nearest.lexical_priority, nearest.lexical_rescue,
                selected.embedding IS NOT NULL AS has_embedding,
                (SELECT count(*) FROM active_tags) AS tag_count,
                nearest.lexical_match_count,
                nearest.rejected_literal_match_count
           FROM selected_questions selected
           LEFT JOIN LATERAL (
             WITH scored AS MATERIALIZED (
               SELECT tag.id AS tag_id, tag.label,
                      tag.embedding <=> selected.embedding AS distance,
                      selected.prompt_document @@ ANY(tag.lexical_queries)
                        AS lexical_match
                 FROM active_tags tag
                WHERE selected.embedding IS NOT NULL
             ), classified AS MATERIALIZED (
               SELECT *,
                      distance <= $5 AS semantic_match,
                      lexical_match AND distance <= $6 AS lexical_priority,
                      lexical_match AND distance > $5 AND distance <= $6
                        AS lexical_rescue
                 FROM scored
             ), stats AS (
               SELECT count(*) FILTER (WHERE lexical_match) AS lexical_match_count,
                      count(*) FILTER (
                        WHERE lexical_match
                          AND NOT semantic_match
                          AND NOT lexical_rescue
                      ) AS rejected_literal_match_count
                 FROM classified
             ), nearest_tags AS (
               SELECT tag_id, label, distance, lexical_priority, lexical_rescue
                 FROM classified
                WHERE semantic_match OR lexical_priority
                ORDER BY lexical_priority DESC, distance, tag_id
                LIMIT $4
             )
             SELECT nearest_tags.*, stats.lexical_match_count,
                    stats.rejected_literal_match_count
               FROM stats
               LEFT JOIN nearest_tags ON true
           ) nearest ON true
          ORDER BY selected.question_id, nearest.lexical_priority DESC NULLS LAST,
                   nearest.distance, nearest.tag_id`,
        [
          input.learnerId,
          space.id,
          questionIds,
          limit,
          MAX_RELATED_TAG_DISTANCE,
          MAX_LEXICAL_RESCUE_DISTANCE,
        ],
      );
      const statsByQuestion = new Map<
        string,
        { lexicalMatches: number; rejectedLiteralMatches: number }
      >();
      let lexicalRescues = 0;
      let semanticSelections = 0;
      for (const row of result.rows) {
        statsByQuestion.set(row.question_id, {
          lexicalMatches: Number(row.lexical_match_count),
          rejectedLiteralMatches: Number(row.rejected_literal_match_count),
        });
        if (row.tag_id && row.label) {
          output.get(row.question_id)?.push({ id: row.tag_id, label: row.label });
          if (row.lexical_rescue) lexicalRescues += 1;
          if (!row.lexical_priority) semanticSelections += 1;
        }
      }
      const embeddedQuestionIds = new Set(
        result.rows.filter((row) => row.has_embedding).map((row) => row.question_id),
      );
      const missingQuestionIds = new Set(
        result.rows.filter((row) => !row.has_embedding).map((row) => row.question_id),
      );
      const resultCount = [...output.values()].reduce(
        (count, tags) => count + tags.length,
        0,
      );
      span.setAttribute("semantic.result_count", resultCount);
      span.setAttribute("semantic.lexical_rescue_count", lexicalRescues);
      span.setAttribute("semantic.semantic_selection_count", semanticSelections);
      span.setAttribute(
        "semantic.lexical_match_count",
        [...statsByQuestion.values()].reduce(
          (count, stats) => count + stats.lexicalMatches,
          0,
        ),
      );
      span.setAttribute(
        "semantic.rejected_literal_match_count",
        [...statsByQuestion.values()].reduce(
          (count, stats) => count + stats.rejectedLiteralMatches,
          0,
        ),
      );
      span.setAttribute("semantic.missing_vector_count", missingQuestionIds.size);
      span.setAttribute(
        "semantic.distance_comparisons",
        embeddedQuestionIds.size * Number(result.rows[0]?.tag_count ?? 0),
      );
      return output;
    },
  );
}

export async function relatedQuestions(input: {
  learnerId: string;
  tagIds: readonly string[];
  lifecycle?: V2QuestionLifecycle | null;
  text?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ questionIds: string[]; nextCursor: string | null }> {
  const tagIds = [...new Set(input.tagIds)];
  if (
    tagIds.length === 0 ||
    tagIds.length > MAX_SELECTED_TAGS ||
    tagIds.some((id) => !UUID_PATTERN.test(id))
  ) {
    throw new Error(`Choose between 1 and ${MAX_SELECTED_TAGS} valid Tags.`);
  }
  const lifecycle = input.lifecycle ?? null;
  const text = input.text?.normalize("NFKC").trim().slice(0, 2_000) ?? "";
  const limit = Math.max(
    1,
    Math.min(MAX_RELATED_QUESTIONS, input.limit ?? MAX_RELATED_QUESTIONS),
  );
  const space = activeEmbeddingSpace();
  const fingerprint = queryFingerprint({ spaceKey: space.key, tagIds, lifecycle, text });
  const cursor = parseCursor(input.cursor, { spaceKey: space.key, fingerprint });
  const pool = getV2Client().pool;
  const selected = await pool.query<{ id: string }>(
    `SELECT tag.id
       FROM waxon_v2.tags tag
       JOIN waxon_v2.tag_embeddings embedding
         ON embedding.user_id = tag.user_id
        AND embedding.tag_id = tag.id
        AND embedding.space_id = $2
      WHERE tag.user_id = $1
        AND tag.deleted_at IS NULL
        AND tag.id = ANY($3::uuid[])`,
    [input.learnerId, space.id, tagIds],
  );
  if (selected.rows.length !== tagIds.length) {
    throw new Error("Selected Tags must be active, owned, and embedded.");
  }

  return Sentry.startSpan(
    {
      name: "semantic_tags.related_questions",
      op: "db.query",
      attributes: { "embedding.space": space.key, "semantic.tag_count": tagIds.length },
    },
    async (span) => {
      const result = await pool.query<{
        question_id: string | null;
        distance: number | string | null;
        lexical_tier: number | string | null;
        lexical_rescue: boolean | null;
        embedded_count: number | string;
        missing_vector_count: number | string;
        lexical_match_count: number | string;
        lexical_rescue_count: number | string;
        rejected_literal_match_count: number | string;
      }>(
         `WITH selected_tags AS MATERIALIZED (
           SELECT tag.id, embedding.embedding,
                  ARRAY(
                    SELECT phraseto_tsquery('simple', term.value)
                      FROM unnest(array_prepend(tag.label, tag.aliases))
                           AS term(value)
                  ) AS lexical_queries
             FROM waxon_v2.tag_embeddings embedding
             JOIN waxon_v2.tags tag
               ON tag.user_id = embedding.user_id
              AND tag.id = embedding.tag_id
            WHERE embedding.user_id = $1
              AND embedding.space_id = $2
              AND embedding.tag_id = ANY($3::uuid[])
              AND tag.deleted_at IS NULL
         ), eligible_questions AS MATERIALIZED (
           SELECT question.id AS question_id,
                  to_tsvector('simple', question.prompt) AS prompt_document,
                  question_embedding.embedding
             FROM waxon_v2.questions question
             LEFT JOIN waxon_v2.question_embeddings question_embedding
               ON question_embedding.user_id = question.user_id
              AND question_embedding.question_id = question.id
              AND question_embedding.space_id = $2
            WHERE question.user_id = $1
              AND question.lifecycle::text IN ('active','flagged','archived')
              AND ($4::text IS NULL OR question.lifecycle::text = $4)
              AND (
                $5 = ''
                OR (
                  setweight(to_tsvector('simple', coalesce(question.prompt, '')), 'A')
                  || setweight(
                       to_tsvector('simple', coalesce(question.reference_answer, '')),
                       'B'
                     )
                ) @@ websearch_to_tsquery('simple', $5)
                OR question.prompt % $5
              )
         ), eligible_stats AS (
           SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_count,
                  count(*) FILTER (WHERE embedding IS NULL) AS missing_vector_count
             FROM eligible_questions
         ), pairs AS MATERIALIZED (
           SELECT question.question_id, tag.id AS tag_id,
                  question.embedding <=> tag.embedding AS distance,
                  question.prompt_document @@ ANY(tag.lexical_queries)
                    AS lexical_match
             FROM eligible_questions question
             CROSS JOIN selected_tags tag
            WHERE question.embedding IS NOT NULL
         ), pair_stats AS (
           SELECT count(*) FILTER (WHERE lexical_match) AS lexical_match_count,
                  count(*) FILTER (
                    WHERE lexical_match AND distance > $11 AND distance <= $10
                  ) AS lexical_rescue_count,
                  count(*) FILTER (
                    WHERE lexical_match AND distance > $10
                  ) AS rejected_literal_match_count
             FROM pairs
         ), ranked AS MATERIALIZED (
           SELECT question_id, min(distance) AS distance,
                  CASE WHEN bool_or(
                    lexical_match AND distance <= $10
                  ) THEN 0 ELSE 1 END AS lexical_tier,
                  bool_or(
                    lexical_match AND distance > $11 AND distance <= $10
                  ) AS lexical_rescue
             FROM pairs
            GROUP BY question_id
         ), page AS (
           SELECT question_id, distance, lexical_tier, lexical_rescue
             FROM ranked
            WHERE (
              $6::int IS NULL
              OR lexical_tier > $6
              OR (lexical_tier = $6 AND distance > $7)
              OR (
                lexical_tier = $6
                AND distance = $7
                AND question_id > $8::uuid
              )
            )
            ORDER BY lexical_tier, distance, question_id
            LIMIT $9
         )
         SELECT page.question_id, page.distance, page.lexical_tier,
                page.lexical_rescue,
                eligible_stats.embedded_count,
                eligible_stats.missing_vector_count,
                pair_stats.lexical_match_count,
                pair_stats.lexical_rescue_count,
                pair_stats.rejected_literal_match_count
           FROM eligible_stats
           CROSS JOIN pair_stats
           LEFT JOIN page ON true
          ORDER BY page.lexical_tier, page.distance, page.question_id`,
        [
          input.learnerId,
          space.id,
          tagIds,
          lifecycle,
          text,
          cursor?.lexicalTier ?? null,
          cursor?.distance ?? null,
          cursor?.questionId ?? null,
          limit + 1,
          MAX_LEXICAL_RESCUE_DISTANCE,
          MAX_RELATED_TAG_DISTANCE,
        ],
      );
      const matchedRows = result.rows.filter(
        (row): row is typeof row & {
          question_id: string;
          distance: number | string;
          lexical_tier: number | string;
        } => row.question_id !== null && row.distance !== null && row.lexical_tier !== null,
      );
      const page = matchedRows.slice(0, limit);
      const last = page.at(-1);
      const lexicalRescues = page.filter((row) => row.lexical_rescue).length;
      span.setAttribute("semantic.result_count", page.length);
      span.setAttribute("semantic.lexical_rescue_count", lexicalRescues);
      span.setAttribute(
        "semantic.semantic_selection_count",
        page.filter((row) => Number(row.lexical_tier) === 1).length,
      );
      span.setAttribute(
        "semantic.lexical_match_count",
        Number(result.rows[0]?.lexical_match_count ?? 0),
      );
      span.setAttribute(
        "semantic.rejected_literal_match_count",
        Number(result.rows[0]?.rejected_literal_match_count ?? 0),
      );
      span.setAttribute(
        "semantic.missing_vector_count",
        Number(result.rows[0]?.missing_vector_count ?? 0),
      );
      span.setAttribute(
        "semantic.distance_comparisons",
        Number(result.rows[0]?.embedded_count ?? 0) * tagIds.length,
      );
      return {
        questionIds: page.map((row) => row.question_id),
        nextCursor:
          matchedRows.length > limit && last
            ? encodeCursor({
                rankingKey: HYBRID_RANKING_KEY,
                spaceKey: space.key,
                fingerprint,
                lexicalTier: Number(last.lexical_tier) as 0 | 1,
                distance: Number(last.distance),
                questionId: last.question_id,
              })
            : null,
      };
    },
  );
}
