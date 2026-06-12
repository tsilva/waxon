import { pool } from "@/app/db/client";
import { normalizeConceptSlug } from "./conceptSlug";

const DEFAULT_QUESTION_BANK_LIMIT = 500;
const MAX_QUESTION_BANK_LIMIT = 1_000;

export type QuestionBankStatusFilter = "all" | "due" | "flagged" | "untagged";

export type QuestionBankItem = {
  questionId: string;
  question: string;
  conciseAnswer: string | null;
  questionProvenance: string | null;
  nextDue: number;
  createdAt: number;
  flaggedAt: number | null;
  conceptSlugs: string[];
};

export type QuestionBankPage = {
  items: QuestionBankItem[];
  total: number;
};

function normalizeStatus(value: unknown): QuestionBankStatusFilter {
  return value === "due" || value === "flagged" || value === "untagged"
    ? value
    : "all";
}

export async function listQuestionBankItems(input: {
  userId: string;
  query?: string | null;
  tagSlug?: string | null;
  status?: QuestionBankStatusFilter | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<QuestionBankPage> {
  const query = input.query?.trim() ?? "";
  const tagSlug = normalizeConceptSlug(input.tagSlug);
  const status = normalizeStatus(input.status);
  const limit = Math.max(
    1,
    Math.min(
      MAX_QUESTION_BANK_LIMIT,
      Math.floor(input.limit ?? DEFAULT_QUESTION_BANK_LIMIT),
    ),
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const now = Math.round(Date.now());
  const result = await pool.query(
    `
      WITH owned_questions AS (
        SELECT
          q.id,
          q.question,
          q.concise_answer,
          q.question_provenance,
          q.next_due,
          q.created_at,
          q.flagged_at
        FROM questions q
        INNER JOIN decks d ON d.id = q.deck_id
        WHERE d.user_id = $1
          AND d.archived_at IS NULL
      ),
      visible_tag_links AS (
        SELECT
          qct.question_id,
          ct.slug
        FROM question_concept_tags qct
        INNER JOIN concept_tags ct ON ct.id = qct.concept_tag_id
        WHERE ct.user_id = $1
          AND ct.slug NOT LIKE 'course-%'
          AND NOT EXISTS (
            SELECT 1
            FROM decks legacy_decks
            WHERE legacy_decks.user_id = ct.user_id
              AND coalesce(nullif(lower(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(unaccent(legacy_decks.name), '[^A-Za-z0-9]+', '-', 'g'),
                    '(^-+|-+$)',
                    '',
                    'g'
                  ),
                  '-+',
                  '-',
                  'g'
                )
              ), ''), 'untitled-deck') = ct.slug
          )
      ),
      question_rows AS (
        SELECT
          oq.id,
          oq.question,
          oq.concise_answer,
          oq.question_provenance,
          oq.next_due,
          oq.created_at,
          oq.flagged_at,
          coalesce(array_remove(array_agg(vtl.slug ORDER BY vtl.slug), NULL), '{}') AS concept_slugs
        FROM owned_questions oq
        LEFT JOIN visible_tag_links vtl ON vtl.question_id = oq.id
        GROUP BY
          oq.id,
          oq.question,
          oq.concise_answer,
          oq.question_provenance,
          oq.next_due,
          oq.created_at,
          oq.flagged_at
      ),
      filtered AS (
        SELECT *
        FROM question_rows
        WHERE ($2::text = ''
            OR question ILIKE '%' || $2::text || '%'
            OR concise_answer ILIKE '%' || $2::text || '%'
            OR question_provenance ILIKE '%' || $2::text || '%'
            OR EXISTS (
              SELECT 1 FROM unnest(concept_slugs) slug
              WHERE slug ILIKE '%' || $2::text || '%'
            ))
          AND ($3::text = '' OR $3::text = ANY(concept_slugs))
          AND (
            $4::text = 'all'
            OR ($4::text = 'due' AND next_due <= $5 AND flagged_at IS NULL)
            OR ($4::text = 'flagged' AND flagged_at IS NOT NULL)
            OR ($4::text = 'untagged' AND cardinality(concept_slugs) = 0)
          )
      )
      SELECT
        id::text,
        question,
        concise_answer,
        question_provenance,
        next_due,
        created_at,
        flagged_at,
        concept_slugs,
        count(*) OVER() AS total
      FROM filtered
      ORDER BY
        flagged_at IS NOT NULL ASC,
        next_due ASC,
        created_at DESC,
        question ASC
      LIMIT $6 OFFSET $7
    `,
    [input.userId, query, tagSlug, status, now, limit, offset],
  );

  return {
    items: result.rows.map((row) => ({
      questionId: String(row.id),
      question: String(row.question ?? ""),
      conciseAnswer: row.concise_answer ? String(row.concise_answer) : null,
      questionProvenance: row.question_provenance
        ? String(row.question_provenance)
        : null,
      nextDue: Number(row.next_due) || 0,
      createdAt: Number(row.created_at) || 0,
      flaggedAt: row.flagged_at === null ? null : Number(row.flagged_at) || 0,
      conceptSlugs: Array.isArray(row.concept_slugs)
        ? row.concept_slugs.map(String).filter(Boolean)
        : [],
    })),
    total: Number(result.rows[0]?.total) || 0,
  };
}
