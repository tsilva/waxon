import { pool } from "@/app/db/client";
import { normalizeConceptSlug } from "../../shared/concept-slug.mjs";
import { vectorLiteral } from "../../shared/vector-literal.mjs";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  normalizeEmbeddingText,
  requestEmbeddings,
  resolveEmbeddingModel,
} from "./embeddingSource";
import {
  hasReviewEligibleQuestions,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
} from "./postgresStore";
import type { NormalizedQuestionDraft } from "./questionDraft";
import {
  gateNovelQuestions,
  type NovelQuestionGateResult,
} from "./semanticDedupe";

const DEFAULT_QUESTION_BANK_LIMIT = 50;
const MAX_QUESTION_BANK_LIMIT = 100;
const MAX_MEANING_SEARCH_RESULTS = 200;

export type QuestionBankStatusFilter = "all" | "due" | "flagged" | "untagged";
export type QuestionBankSearchMode = "text" | "meaning";
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

function acceptQuestionsWithoutNoveltyGate(
  input: NormalizedQuestionDraft[],
): NovelQuestionGateResult {
  const accepted = input.map((draft) => ({
      ...draft,
      embedding: [],
      sourceHash: "",
    }));

  return {
    accepted,
    rejected: [],
  };
}

export async function addQuestionsToKnowledgeBase(input: {
  userId: string;
  questions: NormalizedQuestionDraft[];
  sourceQuestion?: string | null;
}): Promise<{ added: number; rejected: number }> {
  const hasExistingQuestions = await hasReviewEligibleQuestions({
    userId: input.userId,
  });
  const gateResult =
    hasExistingQuestions
      ? await gateNovelQuestions(input.questions, {
          operation: "add_questions_gate",
          userId: input.userId,
        })
      : acceptQuestionsWithoutNoveltyGate(input.questions);
  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted,
    sourceQuestion: input.sourceQuestion ?? null,
    now: Date.now(),
    userId: input.userId,
  });

  await upsertQuestionEmbeddings({
    embeddings: gateResult.accepted
      .filter((candidate) => candidate.embedding.length > 0)
      .map((candidate) => ({
        question: candidate.question,
        embeddingModel: resolveEmbeddingModel(),
        embeddingKind: DEDUPE_EMBEDDING_KIND,
        sourceVersion: DEDUPE_SOURCE_VERSION,
        sourceHash: candidate.sourceHash,
        embedding: candidate.embedding,
      })),
    userId: input.userId,
  });

  return {
    added: addedQuestions.length,
    rejected: gateResult.rejected.length,
  };
}

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

async function embedQuestionBankSearchQuery(input: {
  query: string;
  userId: string;
}): Promise<number[]> {
  const embeddings = await requestEmbeddings({
    texts: [input.query],
    trace: {
      operation: "question_bank_search_embedding",
      userId: input.userId,
      question: input.query,
    },
  });

  return embeddings[0] ?? [];
}

export async function queryQuestionBankItems(input: {
  userId: string;
  searchMode?: QuestionBankSearchMode | null;
  query?: string | null;
  tagSlug?: string | null;
  tagSlugs?: string[] | null;
  status?: QuestionBankStatusFilter | null;
  sort?: QuestionBankSort | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<QuestionBankPage> {
  const rawQuery = input.query?.trim() ?? "";
  const searchMode: QuestionBankSearchMode =
    input.searchMode === "meaning" && rawQuery ? "meaning" : "text";
  const query =
    searchMode === "meaning" ? normalizeEmbeddingText(rawQuery) : rawQuery;
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
  const remainingMeaningResults = Math.max(
    0,
    MAX_MEANING_SEARCH_RESULTS - offset,
  );
  const pageLimit =
    searchMode === "meaning"
      ? Math.min(limit + 1, remainingMeaningResults)
      : limit + 1;

  if (pageLimit === 0) {
    return {
      items: [],
      total: Math.min(offset, MAX_MEANING_SEARCH_RESULTS),
      hasMore: false,
      nextOffset: null,
    };
  }

  const queryEmbedding =
    searchMode === "meaning"
      ? await embedQuestionBankSearchQuery({ query, userId: input.userId })
      : null;

  if (
    queryEmbedding !== null &&
    queryEmbedding.length !== DEDUPE_EMBEDDING_DIMENSIONS
  ) {
    throw new Error("Search query embedding has an unexpected dimension.");
  }

  const now = Math.round(Date.now());
  const result = await pool.query(
    `
      WITH visible_concept_tags AS (
        SELECT
          ct.id,
          ct.slug
        FROM concept_tags ct
        WHERE ct.user_id = $1
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
          q.flagged_at,
          CASE WHEN $9::text = 'meaning'
            THEN qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
              <=> $10::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
            ELSE NULL
          END AS distance
        FROM questions q
        LEFT JOIN question_embeddings qe
          ON qe.question_id = q.id
          AND qe.user_id = q.user_id
          AND qe.embedding_model = $11
          AND qe.embedding_kind = $12
          AND qe.source_version = $13
          AND qe.is_current = true
        WHERE q.user_id = $1
          AND ($9::text <> 'meaning' OR qe.question_id IS NOT NULL)
          AND ($9::text <> 'text' OR $2::text = ''
            OR q.id::text ILIKE '%' || $2::text || '%'
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
          CASE WHEN $9::text = 'meaning' THEN distance END ASC,
          CASE WHEN $9::text = 'text' AND $8::text = 'due' THEN flagged_at IS NOT NULL END ASC,
          CASE WHEN $9::text = 'text' AND $8::text = 'due' THEN next_due END ASC,
          CASE WHEN $9::text = 'text' AND $8::text = 'created-desc' THEN created_at END DESC,
          CASE WHEN $9::text = 'text' AND $8::text = 'created-asc' THEN created_at END ASC,
          CASE WHEN $9::text = 'text' AND $8::text = 'updated-desc' THEN updated_at END DESC,
          CASE WHEN $9::text = 'text' AND $8::text = 'updated-asc' THEN updated_at END ASC,
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
        pq.distance,
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
        pq.flagged_at,
        pq.distance
      ORDER BY
        CASE WHEN $9::text = 'meaning' THEN pq.distance END ASC,
        CASE WHEN $9::text = 'text' AND $8::text = 'due' THEN pq.flagged_at IS NOT NULL END ASC,
        CASE WHEN $9::text = 'text' AND $8::text = 'due' THEN pq.next_due END ASC,
        CASE WHEN $9::text = 'text' AND $8::text = 'created-desc' THEN pq.created_at END DESC,
        CASE WHEN $9::text = 'text' AND $8::text = 'created-asc' THEN pq.created_at END ASC,
        CASE WHEN $9::text = 'text' AND $8::text = 'updated-desc' THEN pq.updated_at END DESC,
        CASE WHEN $9::text = 'text' AND $8::text = 'updated-asc' THEN pq.updated_at END ASC,
        pq.created_at DESC,
        pq.question ASC
    `,
    [
      input.userId,
      query,
      tagSlugs,
      status,
      now,
      pageLimit,
      offset,
      sort,
      searchMode,
      queryEmbedding === null ? null : vectorLiteral(queryEmbedding),
      resolveEmbeddingModel(),
      DEDUPE_EMBEDDING_KIND,
      DEDUPE_SOURCE_VERSION,
    ],
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
