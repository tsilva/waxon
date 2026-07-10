import { pool } from "@/app/db/client";
import { normalizeConceptSlug } from "./conceptSlug";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  normalizeEmbeddingText,
  resolveEmbeddingModel,
} from "./embeddingSource";
import {
  applyEvaluationToPostgres,
  getQueuedQuestionsByEmbeddingProximityPage,
  getQueuedQuestionsPage,
  upsertDueQuestions,
  upsertQuestionEmbeddings,
  type DueQuestion,
  type QuestionInput,
} from "./postgresStore";
import { getOpenRouterApiKey, openRouterEmbeddings } from "./openRouter";
import { reformatMultipleChoiceQuestionForReview } from "./courseQuestionAttemptParsing";
import type { CourseDetail } from "./courseStore";
import { questionSlug } from "./questionSlug";
import {
  gateNovelQuestions,
  type NovelQuestionGateResult,
} from "./semanticDedupe";

const DEFAULT_QUESTION_BANK_LIMIT = 50;
const MAX_QUESTION_BANK_LIMIT = 100;
const MAX_MEANING_SEARCH_RESULTS = 200;

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

export type CourseChatQuestionAttemptInput = {
  course: CourseDetail;
  question: string;
  answer: string;
  answerSummary: string;
  conciseAnswer: string;
  correctAnswer: string | null;
  justification: string;
  score: number;
  submittedAt: number;
};

export type CourseChatQuestionAttemptResult = {
  questionId: string;
  attemptSaved: boolean;
};

function courseChatQuestionProvenance(course: CourseDetail): string {
  const page = course.toc.pages[course.currentPageIndex];

  return [
    `Course chat: ${course.title}`,
    page ? `Milestone ${course.currentPageIndex + 1}: ${page.title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function recordCourseChatQuestionAttempt(
  input: CourseChatQuestionAttemptInput,
): Promise<CourseChatQuestionAttemptResult | null> {
  const question = reformatMultipleChoiceQuestionForReview(input.question)
    .trim()
    .replace(/\s+/g, " ");
  const answer = input.answer.trim();
  const score = Math.max(0, Math.min(10, Math.round(input.score)));

  if (!question || !answer || !Number.isFinite(score)) {
    return null;
  }

  const now = Date.now();
  const [dueQuestion] = await upsertDueQuestions({
    userId: input.course.userId,
    sourceQuestion: null,
    now,
    questions: [
      {
        question,
        conciseAnswer:
          input.conciseAnswer.trim().replace(/\s+/g, " ") ||
          input.correctAnswer?.trim().replace(/\s+/g, " ") ||
          "",
        questionProvenance: courseChatQuestionProvenance(input.course),
      },
    ],
  });

  if (!dueQuestion) {
    return null;
  }

  const persisted = await applyEvaluationToPostgres({
    questionId: dueQuestion.questionId,
    question: dueQuestion.question,
    answer,
    answerSummary:
      input.answerSummary.trim().replace(/\s+/g, " ") || answer.slice(0, 240),
    correctAnswer:
      input.correctAnswer?.trim().replace(/\s+/g, " ") ||
      input.conciseAnswer.trim().replace(/\s+/g, " ") ||
      null,
    justification:
      input.justification.trim().replace(/\s+/g, " ") ||
      "Recorded from course chat.",
    score,
    submittedAt: input.submittedAt,
    now,
    userId: input.course.userId,
  });

  return {
    questionId: dueQuestion.questionId,
    attemptSaved: Boolean(persisted),
  };
}

function acceptQuestionsWithoutNoveltyGate(
  input: Array<string | QuestionInput>,
): NovelQuestionGateResult {
  const seen = new Set<string>();
  const accepted: NovelQuestionGateResult["accepted"] = [];

  for (const item of input) {
    const question = typeof item === "string" ? item : item.question;
    const normalizedQuestion = question.trim().replace(/\s+/g, " ");
    const slug = questionSlug(normalizedQuestion);

    if (!normalizedQuestion || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    accepted.push({
      question: normalizedQuestion,
      conciseAnswer:
        typeof item === "string"
          ? ""
          : (item.conciseAnswer ?? "").trim().replace(/\s+/g, " "),
      embedding: [],
      sourceHash: "",
    });
  }

  return {
    accepted,
    rejected: [],
  };
}

export async function addQuestionsToKnowledgeBase(input: {
  userId: string;
  questions: Array<string | QuestionInput>;
  sourceQuestion?: string | null;
}): Promise<{ added: number; rejected: number }> {
  const { total: userCardCount } = await getQueuedQuestionsPage({
    userId: input.userId,
    limit: 0,
    offset: 0,
    sortKey: "creation-date",
  });
  const gateResult =
    userCardCount === 0
      ? acceptQuestionsWithoutNoveltyGate(input.questions)
      : await gateNovelQuestions(input.questions, {
          operation: "add_questions_gate",
          userId: input.userId,
        });
  const objectQuestions = input.questions.filter(
    (question): question is QuestionInput => typeof question !== "string",
  );
  const provenanceByQuestion = new Map(
    objectQuestions.map((question) => [
      question.question.trim().replace(/\s+/g, " ").toLowerCase(),
      question.questionProvenance?.trim().replace(/\s+/g, " ") ?? "",
    ]),
  );
  const proposedSlugsByQuestion = new Map(
    objectQuestions.map((question) => [
      question.question.trim().replace(/\s+/g, " ").toLowerCase(),
      question.proposedConceptSlugs ?? [],
    ]),
  );
  const sourceTextByQuestion = new Map(
    objectQuestions.map((question) => [
      question.question.trim().replace(/\s+/g, " ").toLowerCase(),
      question.sourceText ?? "",
    ]),
  );

  const addedQuestions = await upsertDueQuestions({
    questions: gateResult.accepted.map((candidate) => ({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
      questionProvenance:
        provenanceByQuestion.get(candidate.question.toLowerCase()) ?? "",
      proposedConceptSlugs:
        proposedSlugsByQuestion.get(candidate.question.toLowerCase()) ?? [],
      sourceText: sourceTextByQuestion.get(candidate.question.toLowerCase()) ?? "",
    })),
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

function dueQuestionToQuestionBankItem(item: DueQuestion): QuestionBankItem {
  return {
    questionId: item.questionId,
    question: item.question,
    conciseAnswer: item.conciseAnswer,
    questionProvenance: item.questionProvenance,
    nextDue: item.nextDue,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    flaggedAt: item.flaggedAt,
    conceptSlugs: item.conceptSlugs,
  };
}

async function embedQuestionBankSearchQuery(input: {
  query: string;
  userId: string;
}): Promise<number[]> {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  }

  const { response, body } = await openRouterEmbeddings({
    apiKey,
    trace: {
      operation: "question_bank_search_embedding",
      userId: input.userId,
      question: input.query,
    },
    body: {
      model: resolveEmbeddingModel(),
      input: [input.query],
      encoding_format: "float",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter embedding request failed (${response.status}).`);
  }

  const embedding = body.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length !== DEDUPE_EMBEDDING_DIMENSIONS) {
    throw new Error("OpenRouter returned an unexpected search embedding.");
  }

  return embedding.map((component, index) => {
    const value = Number(component);

    if (!Number.isFinite(value)) {
      throw new Error(`Search embedding contains a non-finite value at ${index}.`);
    }

    return value;
  });
}

export async function searchQuestionBankItemsByMeaning(input: {
  userId: string;
  query: string;
  tagSlugs?: string[] | null;
  status?: QuestionBankStatusFilter | null;
  limit?: number | null;
  offset?: number | null;
}): Promise<QuestionBankPage> {
  const query = normalizeEmbeddingText(input.query);

  if (!query) {
    return { items: [], total: 0, hasMore: false, nextOffset: null };
  }

  const tagSlugs = normalizeQuestionBankTagSlugs(input.tagSlugs ?? []);
  const status = normalizeStatus(input.status);
  const limit = Math.max(
    1,
    Math.min(
      MAX_QUESTION_BANK_LIMIT,
      Math.floor(input.limit ?? DEFAULT_QUESTION_BANK_LIMIT),
    ),
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const page = await getQueuedQuestionsByEmbeddingProximityPage({
    userId: input.userId,
    queryEmbedding: await embedQuestionBankSearchQuery({
      query,
      userId: input.userId,
    }),
    embeddingModel: resolveEmbeddingModel(),
    embeddingKind: DEDUPE_EMBEDDING_KIND,
    sourceVersion: DEDUPE_SOURCE_VERSION,
    limit,
    offset,
    maxResults: MAX_MEANING_SEARCH_RESULTS,
  });
  const now = Date.now();
  const items = page.items
    .filter((item) =>
      tagSlugs.every((slug) => item.conceptSlugs.includes(slug)),
    )
    .filter((item) => {
      if (status === "due") {
        return item.nextDue <= now;
      }

      if (status === "untagged") {
        return item.conceptSlugs.length === 0;
      }

      return status !== "flagged";
    })
    .map(dueQuestionToQuestionBankItem);

  return {
    items,
    total: page.total,
    hasMore: false,
    nextOffset: null,
  };
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
