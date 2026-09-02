import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { getV2Client } from "../../db/v2/client.ts";
import { activeEmbeddingSpace } from "./embeddingSpaces.ts";
import type { V2QuestionLifecycle, V2TagRef } from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RELATED_QUESTIONS = 50;
const MAX_RELATED_TAGS = 10;
const MAX_SELECTED_TAGS = 10;

type SemanticCursor = {
  spaceKey: string;
  fingerprint: string;
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
    .update(JSON.stringify({
      spaceKey: input.spaceKey,
      tagIds: [...input.tagIds].sort(),
      lifecycle: input.lifecycle,
      text: input.text,
    }))
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
      parsed.spaceKey !== expected.spaceKey ||
      parsed.fingerprint !== expected.fingerprint ||
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
  if (questionIds.length > 50) {
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
      },
    },
    async (span) => {
      const result = await getV2Client().pool.query<{
        question_id: string;
        tag_id: string | null;
        label: string | null;
        has_embedding: boolean;
        tag_count: number | string;
      }>(
        `WITH selected_questions AS (
           SELECT input.question_id, embedding.embedding
             FROM unnest($3::uuid[]) AS input(question_id)
             JOIN waxon_v2.questions question
               ON question.user_id = $1 AND question.id = input.question_id
             LEFT JOIN waxon_v2.question_embeddings embedding
               ON embedding.user_id = question.user_id
              AND embedding.question_id = question.id
              AND embedding.space_id = $2
         ), active_tag_count AS (
           SELECT count(*) AS value
             FROM waxon_v2.tag_embeddings embedding
             JOIN waxon_v2.tags tag
               ON tag.user_id = embedding.user_id
              AND tag.id = embedding.tag_id
            WHERE embedding.user_id = $1
              AND embedding.space_id = $2
              AND tag.deleted_at IS NULL
         )
         SELECT selected.question_id, nearest.tag_id, nearest.label,
                selected.embedding IS NOT NULL AS has_embedding,
                active_tag_count.value AS tag_count
           FROM selected_questions selected
           CROSS JOIN active_tag_count
           LEFT JOIN LATERAL (
             SELECT tag.id AS tag_id, tag.label,
                    embedding.embedding <=> selected.embedding AS distance
               FROM waxon_v2.tag_embeddings embedding
               JOIN waxon_v2.tags tag
                 ON tag.user_id = embedding.user_id
                AND tag.id = embedding.tag_id
              WHERE embedding.user_id = $1
                AND embedding.space_id = $2
                AND selected.embedding IS NOT NULL
                AND tag.deleted_at IS NULL
              ORDER BY distance, tag.id
              LIMIT $4
           ) nearest ON true
          ORDER BY selected.question_id, nearest.distance, nearest.tag_id`,
        [input.learnerId, space.id, questionIds, limit],
      );
      for (const row of result.rows) {
        if (row.tag_id && row.label) {
          output.get(row.question_id)?.push({ id: row.tag_id, label: row.label });
        }
      }
      const embeddedQuestionIds = new Set(
        result.rows
          .filter((row) => row.has_embedding)
          .map((row) => row.question_id),
      );
      const missingQuestionIds = new Set(
        result.rows
          .filter((row) => !row.has_embedding)
          .map((row) => row.question_id),
      );
      const resultCount = [...output.values()].reduce(
        (count, tags) => count + tags.length,
        0,
      );
      span.setAttribute("semantic.result_count", resultCount);
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
}): Promise<{
  questionIds: string[];
  nextCursor: string | null;
}> {
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
  const fingerprint = queryFingerprint({
    spaceKey: space.key,
    tagIds,
    lifecycle,
    text,
  });
  const cursor = parseCursor(input.cursor, {
    spaceKey: space.key,
    fingerprint,
  });
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
      attributes: {
        "embedding.space": space.key,
        "semantic.tag_count": tagIds.length,
      },
    },
    async (span) => {
      const result = await pool.query<{
        question_id: string | null;
        distance: number | string | null;
        total_count: number | string | null;
        embedded_count: number | string;
        missing_vector_count: number | string;
      }>(
        `WITH selected_tags AS (
           SELECT embedding.embedding
             FROM waxon_v2.tag_embeddings embedding
             JOIN waxon_v2.tags tag
               ON tag.user_id = embedding.user_id
              AND tag.id = embedding.tag_id
            WHERE embedding.user_id = $1
              AND embedding.space_id = $2
              AND embedding.tag_id = ANY($3::uuid[])
              AND tag.deleted_at IS NULL
         ), eligible_questions AS (
           SELECT question.id AS question_id, question_embedding.embedding
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
                OR to_tsvector('simple', question.prompt || ' ' || question.reference_answer)
                   @@ websearch_to_tsquery('simple', $5)
                OR question.prompt % $5
              )
         ), eligible_stats AS (
           SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_count,
                  count(*) FILTER (WHERE embedding IS NULL) AS missing_vector_count
             FROM eligible_questions
         ), ranked AS (
           SELECT question.question_id,
                  min(question.embedding <=> selected.embedding) AS distance
             FROM eligible_questions question
             CROSS JOIN selected_tags selected
            WHERE question.embedding IS NOT NULL
            GROUP BY question.question_id
         ), page AS (
           SELECT question_id, distance, count(*) OVER () AS total_count
             FROM ranked
            WHERE (
              $6::float8 IS NULL
              OR distance > $6
              OR (distance = $6 AND question_id > $7::uuid)
            )
            ORDER BY distance, question_id
            LIMIT $8
         )
         SELECT page.question_id, page.distance, page.total_count,
                eligible_stats.embedded_count,
                eligible_stats.missing_vector_count
           FROM eligible_stats
           LEFT JOIN page ON true
          ORDER BY page.distance, page.question_id`,
        [
          input.learnerId,
          space.id,
          tagIds,
          lifecycle,
          text,
          cursor?.distance ?? null,
          cursor?.questionId ?? null,
          limit + 1,
        ],
      );
      const matchedRows = result.rows.filter(
        (row): row is typeof row & { question_id: string; distance: number | string } =>
          row.question_id !== null && row.distance !== null,
      );
      const page = matchedRows.slice(0, limit);
      const last = page.at(-1);
      span.setAttribute("semantic.result_count", page.length);
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
                spaceKey: space.key,
                fingerprint,
                distance: Number(last.distance),
                questionId: last.question_id,
              })
            : null,
      };
    },
  );
}
