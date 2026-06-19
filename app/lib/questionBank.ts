import { pool } from "@/app/db/client";
import { normalizeConceptSlug } from "./conceptSlug";

const DEFAULT_QUESTION_BANK_LIMIT = 50;
const MAX_QUESTION_BANK_LIMIT = 100;

export type QuestionBankStatusFilter = "all" | "due" | "flagged" | "untagged";
export type QuestionBankSort =
  | "due"
  | "created-desc"
  | "created-asc"
  | "updated-desc"
  | "updated-asc";

export type QuestionBankItem = {
  questionId: string;
  question: string;
  conciseAnswer: string | null;
  questionProvenance: string | null;
  nextDue: number;
  createdAt: number;
  updatedAt: number;
  flaggedAt: number | null;
  conceptSlugs: string[];
};

export type QuestionBankPage = {
  items: QuestionBankItem[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
};

function normalizeQuestionBankTagSlugs(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const slugs: string[] = [];

  for (const item of values) {
    const slug = normalizeConceptSlug(item);

    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    slugs.push(slug);

    if (slugs.length >= 8) {
      break;
    }
  }

  return slugs;
}

function normalizeStatus(value: unknown): QuestionBankStatusFilter {
  return value === "due" || value === "flagged" || value === "untagged"
    ? value
    : "all";
}

export function normalizeQuestionBankSort(value: unknown): QuestionBankSort {
  return value === "created-desc" ||
    value === "created-asc" ||
    value === "updated-desc" ||
    value === "updated-asc"
    ? value
    : "due";
}

export async function listQuestionBankItems(input: {
  userId: string;
  query?: string | null;
  tagSlug?: string | null;
  tagSlugs?: string[] | null;
  status?: QuestionBankStatusFilter | null;
  sort?: QuestionBankSort | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<QuestionBankPage> {
  const query = input.query?.trim() ?? "";
  const tagSlugs = normalizeQuestionBankTagSlugs(
    input.tagSlugs && input.tagSlugs.length > 0
      ? input.tagSlugs
      : input.tagSlug,
  );
  const status = normalizeStatus(input.status);
  const sort = normalizeQuestionBankSort(input.sort);
  const limit = Math.max(
    1,
    Math.min(
      MAX_QUESTION_BANK_LIMIT,
      Math.floor(input.limit ?? DEFAULT_QUESTION_BANK_LIMIT),
    ),
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const pageLimit = limit + 1;
  const now = Math.round(Date.now());
  const result = await pool.query(
    `
      WITH visible_concept_tags AS (
        SELECT
          ct.id,
          ct.slug
        FROM concept_tags ct
        WHERE ct.user_id = $1
          AND ct.slug NOT LIKE 'course-%'
      ),
      filtered_questions AS (
        SELECT
          q.id,
          q.question,
          q.concise_answer,
          q.question_provenance,
          q.next_due,
          q.created_at,
          q.updated_at,
          q.flagged_at
        FROM questions q
        WHERE q.user_id = $1
          AND ($2::text = ''
            OR q.question ILIKE '%' || $2::text || '%'
            OR q.concise_answer ILIKE '%' || $2::text || '%'
            OR q.question_provenance ILIKE '%' || $2::text || '%'
            OR EXISTS (
              SELECT 1
              FROM question_concept_tags qct
              INNER JOIN visible_concept_tags vct ON vct.id = qct.concept_tag_id
              WHERE qct.question_id = q.id
                AND vct.slug ILIKE '%' || $2::text || '%'
            ))
          AND (cardinality($3::text[]) = 0 OR NOT EXISTS (
            SELECT 1
            FROM unnest($3::text[]) selected_tag(slug)
            WHERE NOT EXISTS (
              SELECT 1
              FROM question_concept_tags qct
              INNER JOIN visible_concept_tags vct ON vct.id = qct.concept_tag_id
              WHERE qct.question_id = q.id
                AND vct.slug = selected_tag.slug
            )
          ))
          AND (
            $4::text = 'all'
            OR ($4::text = 'due' AND q.next_due <= $5 AND q.flagged_at IS NULL)
            OR ($4::text = 'flagged' AND q.flagged_at IS NOT NULL)
            OR ($4::text = 'untagged' AND NOT EXISTS (
              SELECT 1
              FROM question_concept_tags qct
              INNER JOIN visible_concept_tags vct ON vct.id = qct.concept_tag_id
              WHERE qct.question_id = q.id
            ))
          )
      ),
      page_questions AS (
        SELECT *
        FROM filtered_questions
        ORDER BY
          CASE WHEN $8::text = 'due' THEN flagged_at IS NOT NULL END ASC,
          CASE WHEN $8::text = 'due' THEN next_due END ASC,
          CASE WHEN $8::text = 'created-desc' THEN created_at END DESC,
          CASE WHEN $8::text = 'created-asc' THEN created_at END ASC,
          CASE WHEN $8::text = 'updated-desc' THEN updated_at END DESC,
          CASE WHEN $8::text = 'updated-asc' THEN updated_at END ASC,
          created_at DESC,
          question ASC
        LIMIT $6 OFFSET $7
      )
      SELECT
        pq.id::text,
        pq.question,
        pq.concise_answer,
        pq.question_provenance,
        pq.next_due,
        pq.created_at,
        pq.updated_at,
        pq.flagged_at,
        coalesce(
          array_agg(vct.slug ORDER BY vct.slug) FILTER (WHERE vct.slug IS NOT NULL),
          '{}'
        ) AS concept_slugs
      FROM page_questions pq
      LEFT JOIN question_concept_tags qct ON qct.question_id = pq.id
      LEFT JOIN visible_concept_tags vct ON vct.id = qct.concept_tag_id
      GROUP BY
        pq.id,
        pq.question,
        pq.concise_answer,
        pq.question_provenance,
        pq.next_due,
        pq.created_at,
        pq.updated_at,
        pq.flagged_at
      ORDER BY
        CASE WHEN $8::text = 'due' THEN pq.flagged_at IS NOT NULL END ASC,
        CASE WHEN $8::text = 'due' THEN pq.next_due END ASC,
        CASE WHEN $8::text = 'created-desc' THEN pq.created_at END DESC,
        CASE WHEN $8::text = 'created-asc' THEN pq.created_at END ASC,
        CASE WHEN $8::text = 'updated-desc' THEN pq.updated_at END DESC,
        CASE WHEN $8::text = 'updated-asc' THEN pq.updated_at END ASC,
        pq.created_at DESC,
        pq.question ASC
    `,
    [input.userId, query, tagSlugs, status, now, pageLimit, offset, sort],
  );
  const hasMore = result.rows.length > limit;
  const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;

  return {
    items: pageRows.map((row) => ({
      questionId: String(row.id),
      question: String(row.question ?? ""),
      conciseAnswer: row.concise_answer ? String(row.concise_answer) : null,
      questionProvenance: row.question_provenance
        ? String(row.question_provenance)
        : null,
      nextDue: Number(row.next_due) || 0,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      flaggedAt: row.flagged_at === null ? null : Number(row.flagged_at) || 0,
      conceptSlugs: Array.isArray(row.concept_slugs)
        ? row.concept_slugs.map(String).filter(Boolean)
        : [],
    })),
    total: offset + pageRows.length + (hasMore ? 1 : 0),
    hasMore,
    nextOffset: hasMore ? offset + pageRows.length : null,
  };
}
