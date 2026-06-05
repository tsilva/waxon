import { pool } from "@/app/db/client";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddingSource";

export type ExistingQuestionNeighbor = {
  question: string;
  conciseAnswer: string;
  similarity: number;
};

const DEFAULT_DECK_ID = "deep-learning";
const DEFAULT_NEIGHBOR_LIMIT = 5;
const MAX_NEIGHBOR_LIMIT = 10;
const MIN_CONTEXT_SIMILARITY = 0.72;

export async function loadExistingQuestionNeighbors(input: {
  question: string;
  deckId?: string | null;
  limit?: number;
  minSimilarity?: number;
}): Promise<ExistingQuestionNeighbor[]> {
  const question = input.question.trim().replace(/\s+/g, " ");

  if (!question) {
    return [];
  }

  const deckId = input.deckId?.trim() || DEFAULT_DECK_ID;
  const limit = Math.max(
    1,
    Math.min(MAX_NEIGHBOR_LIMIT, input.limit ?? DEFAULT_NEIGHBOR_LIMIT),
  );
  const minSimilarity = input.minSimilarity ?? MIN_CONTEXT_SIMILARITY;
  const result = await pool.query(
    `
      WITH source AS (
        SELECT qe.question_id, qe.embedding
        FROM question_embeddings qe
        WHERE qe.deck_id = $1
          AND qe.question = $2
          AND qe.embedding_model = $3
          AND qe.embedding_kind = $4
          AND qe.source_version = $5
          AND qe.is_current = true
        ORDER BY qe.updated_at DESC
        LIMIT 1
      )
      SELECT
        q.question,
        q.concise_answer,
        qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> source.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS}) AS distance
      FROM source
      CROSS JOIN LATERAL (
        SELECT candidate.question_id, candidate.embedding
        FROM question_embeddings candidate
        WHERE candidate.deck_id = $1
          AND candidate.question_id <> source.question_id
          AND candidate.embedding_model = $3
          AND candidate.embedding_kind = $4
          AND candidate.source_version = $5
          AND candidate.is_current = true
        ORDER BY candidate.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> source.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
        LIMIT $6
      ) qe
      JOIN questions q ON q.id = qe.question_id AND q.deck_id = $1
      ORDER BY distance ASC
    `,
    [
      deckId,
      question,
      process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      DEDUPE_EMBEDDING_KIND,
      DEDUPE_SOURCE_VERSION,
      limit,
    ],
  );

  return (
    result.rows as Array<{
      question: string;
      concise_answer: string | null;
      distance: number | string;
    }>
  )
    .map((row) => ({
      question: row.question,
      conciseAnswer: row.concise_answer ?? "",
      similarity: Number((1 - Number(row.distance)).toFixed(4)),
    }))
    .filter(
      (neighbor) =>
        Number.isFinite(neighbor.similarity) &&
        neighbor.similarity >= minSimilarity,
    );
}
