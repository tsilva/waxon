import { and, count, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, pool } from "@/app/db/client";
import {
  conceptTags,
  decks,
  questionConceptTags,
  questions,
} from "@/app/db/schema";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEDUPE_EMBEDDING_DIMENSIONS,
} from "./embeddingSource";
import { extractJsonObject } from "./jsonObject";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  getOpenRouterChatModel,
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "./openRouter";
import { vectorLiteral } from "./vectorLiteral";
export {
  fallbackConceptSlug,
  isUsefulConceptSlug,
  normalizeConceptSlug,
  normalizeConceptSlugList,
  isScaffoldingConceptSlug,
} from "./conceptSlug";
import {
  fallbackConceptSlug,
  isUsefulConceptSlug,
  isScaffoldingConceptSlug,
  normalizeConceptSlug,
  normalizeConceptSlugList,
} from "./conceptSlug";

const MAX_PROPOSED_SLUGS = 8;
const MAX_SOURCE_TEXT_CHARS = 4_000;
const MAX_TAGGING_CONTEXT_CHARS = 5_000;
const MAX_RELEVANT_TAGS = 20;
const CONCEPT_TAGGING_RESPONSE_FORMAT = { type: "json_object" };

export type ConceptTaggedQuestion = {
  questionId: string;
  question: string;
  conciseAnswer?: string | null;
  questionProvenance?: string | null;
  sourceText?: string | null;
  proposedConceptSlugs?: string[] | null;
  fallbackSlug?: string | null;
};

export type ConceptTagSummary = {
  id: string;
  slug: string;
  active: boolean;
  questionCount: number;
  dueCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ConceptTaggedQuestionSummary = {
  questionId: string;
  question: string;
  deckName: string;
  nextDue: number;
};

type RelevantConceptTag = {
  id: string;
  slug: string;
};

type ConceptAssignment = {
  questionId: string;
  slugs: string[];
};

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deterministicFallbackSlug(input: ConceptTaggedQuestion): string {
  const proposed = normalizeConceptSlugList(input.proposedConceptSlugs).at(0);

  if (proposed) {
    return proposed;
  }

  const contextSlug = normalizeConceptSlug(input.fallbackSlug);

  if (isUsefulConceptSlug(contextSlug) && !isScaffoldingConceptSlug(contextSlug)) {
    return contextSlug;
  }

  return fallbackConceptSlug();
}

function visibleConceptTagClause() {
  return sql`
    ${conceptTags.slug} NOT LIKE 'course-%'
    AND NOT EXISTS (
      SELECT 1
      FROM decks legacy_decks
      WHERE legacy_decks.user_id = ${conceptTags.userId}
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
        ), ''), 'untitled-deck') = ${conceptTags.slug}
    )
  `;
}

function buildTaggingContext(question: ConceptTaggedQuestion): string {
  return [
    `Question: ${question.question}`,
    question.conciseAnswer ? `Answer: ${question.conciseAnswer}` : "",
    question.questionProvenance
      ? `Provenance: ${question.questionProvenance}`
      : "",
    question.sourceText
      ? `Source: ${question.sourceText.slice(0, MAX_SOURCE_TEXT_CHARS)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TAGGING_CONTEXT_CHARS);
}

async function fetchEmbeddings(input: {
  userId: string;
  texts: string[];
  operation: string;
}): Promise<number[][]> {
  if (input.texts.length === 0) {
    return [];
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is not configured.");
  }

  const { response, body } = await openRouterEmbeddings({
    apiKey,
    trace: {
      operation: input.operation,
      userId: input.userId,
      question: input.texts[0]?.slice(0, 240),
    },
    body: {
      model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input: input.texts,
      encoding_format: "float",
    },
  });

  if (!response.ok || !Array.isArray(body.data)) {
    throw new Error(`OpenRouter embedding request failed (${response.status}).`);
  }

  return body.data.map((item, index) => {
    if (!Array.isArray(item.embedding)) {
      throw new Error(`Embedding ${index} is missing.`);
    }

    return item.embedding.map((component) => {
      const value = Number(component);

      if (!Number.isFinite(value)) {
        throw new Error(`Embedding ${index} contains a non-finite value.`);
      }

      return value;
    });
  });
}

async function loadRelevantConceptTags(input: {
  userId: string;
  embedding: number[] | null;
}): Promise<RelevantConceptTag[]> {
  if (!input.embedding || input.embedding.length !== DEDUPE_EMBEDDING_DIMENSIONS) {
    const rows = await db
      .select({
        id: conceptTags.id,
        slug: conceptTags.slug,
      })
      .from(conceptTags)
      .where(and(eq(conceptTags.userId, input.userId), visibleConceptTagClause()))
      .orderBy(conceptTags.slug)
      .limit(MAX_RELEVANT_TAGS);

    return rows;
  }

  const result = await pool.query(
    `
      SELECT id, slug
      FROM concept_tags
      WHERE user_id = $1
        AND slug NOT LIKE 'course-%'
        AND NOT EXISTS (
          SELECT 1
          FROM decks legacy_decks
          WHERE legacy_decks.user_id = concept_tags.user_id
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
            ), ''), 'untitled-deck') = concept_tags.slug
        )
      ORDER BY
        CASE WHEN embedding IS NULL THEN 1 ELSE 0 END ASC,
        embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> $2::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS}) ASC,
        slug ASC
      LIMIT $3
    `,
    [input.userId, vectorLiteral(input.embedding), MAX_RELEVANT_TAGS],
  );

  return result.rows
    .map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
    }))
    .filter((row) => row.id && row.slug);
}

function buildConceptTaggingPrompt(input: {
  questions: ConceptTaggedQuestion[];
  relevantTagsByQuestionId: Map<string, RelevantConceptTag[]>;
}) {
  return [
    "Assign concept slugs to saved Waxon review questions.",
    "Use 1-3 lowercase kebab-case slugs per question.",
    "Prefer existingSlugs when they accurately describe the tested concept.",
    "Create a new slug only when no existing slug fits.",
    "Slugs must be full, self-disambiguating concept phrases.",
    "Do not use acronym-only slugs such as ppo, rl, cnn, or kl unless the acronym is globally unambiguous.",
    "Do not use source, deck, course, lesson, or container labels as concept slugs.",
    "Return strict JSON only: {\"assignments\":[{\"questionId\":\"...\",\"conceptSlugs\":[\"...\"]}]}",
    JSON.stringify({
      questions: input.questions.map((question) => ({
        questionId: question.questionId,
        context: buildTaggingContext(question),
        proposedSlugs: normalizeConceptSlugList(
          (question.proposedConceptSlugs ?? []).slice(0, MAX_PROPOSED_SLUGS),
        ),
        existingSlugs:
          input.relevantTagsByQuestionId
            .get(question.questionId)
            ?.map((tag) => tag.slug) ?? [],
      })),
    }),
  ].join("\n\n");
}

function parseConceptAssignments(input: {
  source: string;
  questions: ConceptTaggedQuestion[];
}): Map<string, string[]> {
  const value = extractJsonObject(input.source);

  if (!value || typeof value !== "object") {
    return new Map();
  }

  const assignments = (value as { assignments?: unknown }).assignments;

  if (!Array.isArray(assignments)) {
    return new Map();
  }

  const questionIds = new Set(input.questions.map((question) => question.questionId));
  const slugsByQuestionId = new Map<string, string[]>();

  for (const item of assignments) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as { questionId?: unknown; conceptSlugs?: unknown };
    const questionId =
      typeof record.questionId === "string" ? record.questionId.trim() : "";

    if (!questionIds.has(questionId)) {
      continue;
    }

    const slugs = normalizeConceptSlugList(record.conceptSlugs);

    if (slugs.length > 0) {
      slugsByQuestionId.set(questionId, slugs);
    }
  }

  return slugsByQuestionId;
}

async function assignWithLlm(input: {
  userId: string;
  questions: ConceptTaggedQuestion[];
  relevantTagsByQuestionId: Map<string, RelevantConceptTag[]>;
}): Promise<Map<string, string[]>> {
  const apiKey = getOpenRouterApiKey();
  const model = getOpenRouterChatModel();

  if (!apiKey || !model || input.questions.length === 0) {
    return new Map();
  }

  const { response, body } = await openRouterChatCompletion({
    apiKey,
    stream: false,
    trace: {
      operation: "concept_tag_assignment",
      userId: input.userId,
      question: input.questions[0]?.question,
    },
    body: {
      model,
      response_format: CONCEPT_TAGGING_RESPONSE_FORMAT,
      temperature: 0.1,
      max_tokens: Math.min(2_400, 240 + input.questions.length * 120),
      messages: [
        {
          role: "system",
          content:
            "You assign compact concept slugs for a spaced-repetition question bank.",
        },
        {
          role: "user",
          content: buildConceptTaggingPrompt(input),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error(`Concept tagging failed (${response.status}).`);
  }

  return parseConceptAssignments({
    source: extractChatCompletionText(body),
    questions: input.questions,
  });
}

async function upsertConceptTags(input: {
  userId: string;
  slugs: string[];
  embeddingsBySlug: Map<string, number[]>;
  now: number;
}): Promise<Map<string, string>> {
  const slugs = Array.from(new Set(input.slugs.map(normalizeConceptSlug))).filter(
    isUsefulConceptSlug,
  );

  if (slugs.length === 0) {
    return new Map();
  }

  await db
    .insert(conceptTags)
    .values(
      slugs.map((slug) => ({
        userId: input.userId,
        slug,
        active: true,
        embedding: input.embeddingsBySlug.get(slug),
        createdAt: input.now,
        updatedAt: input.now,
      })),
    )
    .onConflictDoUpdate({
      target: [conceptTags.userId, conceptTags.slug],
      set: {
        embedding: sql`coalesce(${conceptTags.embedding}, excluded.embedding)`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  const rows = await db
    .select({
      id: conceptTags.id,
      slug: conceptTags.slug,
    })
    .from(conceptTags)
    .where(and(eq(conceptTags.userId, input.userId), inArray(conceptTags.slug, slugs)));

  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function buildEmbeddingsBySlug(input: {
  userId: string;
  slugs: string[];
}): Promise<Map<string, number[]>> {
  const slugs = Array.from(new Set(input.slugs)).filter(isUsefulConceptSlug);

  if (slugs.length === 0) {
    return new Map();
  }

  try {
    const embeddings = await fetchEmbeddings({
      userId: input.userId,
      operation: "concept_tag_embedding",
      texts: slugs.map(titleCaseSlug),
    });

    return new Map(
      slugs
        .map((slug, index) => [slug, embeddings[index] ?? []] as const)
        .filter((entry): entry is [string, number[]] => entry[1].length > 0),
    );
  } catch (error) {
    console.warn("[waxon] concept tag embedding failed", error);
    return new Map();
  }
}

export async function assignConceptSlugsForQuestions(input: {
  userId: string;
  questions: ConceptTaggedQuestion[];
}): Promise<void> {
  const questionsToTag = input.questions.filter(
    (question) => question.questionId && question.question.trim(),
  );

  if (questionsToTag.length === 0) {
    return;
  }

  let contextEmbeddings: number[][] = [];

  try {
    contextEmbeddings = await fetchEmbeddings({
      userId: input.userId,
      operation: "concept_tag_context_embedding",
      texts: questionsToTag.map(buildTaggingContext),
    });
  } catch (error) {
    console.warn("[waxon] concept context embedding failed", error);
  }

  const relevantTagsByQuestionId = new Map<string, RelevantConceptTag[]>();

  await Promise.all(
    questionsToTag.map(async (question, index) => {
      relevantTagsByQuestionId.set(
        question.questionId,
        await loadRelevantConceptTags({
          userId: input.userId,
          embedding: contextEmbeddings[index] ?? null,
        }),
      );
    }),
  );

  let llmAssignments = new Map<string, string[]>();

  try {
    llmAssignments = await assignWithLlm({
      userId: input.userId,
      questions: questionsToTag,
      relevantTagsByQuestionId,
    });
  } catch (error) {
    console.warn("[waxon] concept LLM assignment failed", error);
  }

  const assignments: ConceptAssignment[] = questionsToTag.map((question) => {
    const llmSlugs = normalizeConceptSlugList(llmAssignments.get(question.questionId));
    const proposedSlugs = normalizeConceptSlugList(question.proposedConceptSlugs);
    const fallbackSlug = deterministicFallbackSlug(question);
    const slugs = llmSlugs.length > 0 ? llmSlugs : proposedSlugs;

    return {
      questionId: question.questionId,
      slugs: slugs.length > 0 ? slugs : [fallbackSlug],
    };
  });
  const allSlugs = assignments.flatMap((assignment) => assignment.slugs);
  const now = Math.round(Date.now());
  const tagIdsBySlug = await upsertConceptTags({
    userId: input.userId,
    slugs: allSlugs,
    embeddingsBySlug: await buildEmbeddingsBySlug({
      userId: input.userId,
      slugs: allSlugs,
    }),
    now,
  });
  const links = assignments.flatMap((assignment) =>
    assignment.slugs
      .map((slug) => tagIdsBySlug.get(slug))
      .filter((tagId): tagId is string => Boolean(tagId))
      .map((conceptTagId) => ({
        questionId: assignment.questionId,
        conceptTagId,
        createdAt: now,
      })),
  );

  if (links.length === 0) {
    return;
  }

  await db.insert(questionConceptTags).values(links).onConflictDoNothing();
}

export async function listConceptTags(input: {
  userId: string;
}): Promise<ConceptTagSummary[]> {
  const now = Math.round(Date.now());
  const rows = await db
    .select({
      id: conceptTags.id,
      slug: conceptTags.slug,
      active: conceptTags.active,
      createdAt: conceptTags.createdAt,
      updatedAt: conceptTags.updatedAt,
      questionCount: count(questions.id),
      dueCount: sql<number>`count(${questions.id}) filter (
        where ${questions.nextDue} <= ${now}
          and ${questions.flaggedAt} is null
      )`,
    })
    .from(conceptTags)
    .leftJoin(
      questionConceptTags,
      eq(questionConceptTags.conceptTagId, conceptTags.id),
    )
    .leftJoin(questions, eq(questions.id, questionConceptTags.questionId))
    .where(and(eq(conceptTags.userId, input.userId), visibleConceptTagClause()))
    .groupBy(
      conceptTags.id,
      conceptTags.slug,
      conceptTags.active,
      conceptTags.createdAt,
      conceptTags.updatedAt,
    )
    .orderBy(conceptTags.slug);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    active: row.active,
    questionCount: Number(row.questionCount) || 0,
    dueCount: Number(row.dueCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function setConceptTagActive(input: {
  userId: string;
  slug: string;
  active: boolean;
}): Promise<ConceptTagSummary> {
  const slug = normalizeConceptSlug(input.slug);

  if (!isUsefulConceptSlug(slug)) {
    throw new Error("Concept slug is invalid.");
  }

  await db
    .update(conceptTags)
    .set({ active: input.active, updatedAt: Math.round(Date.now()) })
    .where(and(eq(conceptTags.userId, input.userId), eq(conceptTags.slug, slug)));

  const tag = (await listConceptTags({ userId: input.userId })).find(
    (item) => item.slug === slug,
  );

  if (!tag) {
    throw new Error("Concept tag not found.");
  }

  return tag;
}

export async function listQuestionsForConceptTag(input: {
  userId: string;
  slug: string;
  limit?: number;
}): Promise<ConceptTaggedQuestionSummary[]> {
  const slug = normalizeConceptSlug(input.slug);

  if (!isUsefulConceptSlug(slug)) {
    throw new Error("Concept slug is invalid.");
  }

  const rows = await db
    .select({
      questionId: questions.id,
      question: questions.question,
      deckName: decks.name,
      nextDue: questions.nextDue,
    })
    .from(questionConceptTags)
    .innerJoin(conceptTags, eq(conceptTags.id, questionConceptTags.conceptTagId))
    .innerJoin(questions, eq(questions.id, questionConceptTags.questionId))
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(conceptTags.userId, input.userId),
        eq(conceptTags.slug, slug),
        eq(decks.userId, input.userId),
        isNull(questions.flaggedAt),
      ),
    )
    .orderBy(questions.nextDue, questions.question)
    .limit(Math.max(1, Math.min(200, Math.floor(input.limit ?? 80))));

  return rows;
}

export async function renameConceptTag(input: {
  userId: string;
  fromSlug: string;
  toSlug: string;
}): Promise<ConceptTagSummary> {
  const fromSlug = normalizeConceptSlug(input.fromSlug);
  const toSlug = normalizeConceptSlug(input.toSlug);

  if (!isUsefulConceptSlug(fromSlug) || !isUsefulConceptSlug(toSlug)) {
    throw new Error("Concept slug is invalid.");
  }

  if (fromSlug !== toSlug) {
    await db
      .update(conceptTags)
      .set({ slug: toSlug, updatedAt: Math.round(Date.now()) })
      .where(and(eq(conceptTags.userId, input.userId), eq(conceptTags.slug, fromSlug)));
  }

  const tag = (await listConceptTags({ userId: input.userId })).find(
    (item) => item.slug === toSlug,
  );

  if (!tag) {
    throw new Error("Concept tag not found.");
  }

  return tag;
}

export async function mergeConceptTags(input: {
  userId: string;
  fromSlug: string;
  toSlug: string;
}): Promise<ConceptTagSummary> {
  const fromSlug = normalizeConceptSlug(input.fromSlug);
  const toSlug = normalizeConceptSlug(input.toSlug);

  if (!isUsefulConceptSlug(fromSlug) || !isUsefulConceptSlug(toSlug)) {
    throw new Error("Concept slug is invalid.");
  }

  if (fromSlug === toSlug) {
    const tag = (await listConceptTags({ userId: input.userId })).find(
      (item) => item.slug === toSlug,
    );

    if (!tag) {
      throw new Error("Concept tag not found.");
    }

    return tag;
  }

  const rows = await db
    .select({
      id: conceptTags.id,
      slug: conceptTags.slug,
      active: conceptTags.active,
    })
    .from(conceptTags)
    .where(
      and(
        eq(conceptTags.userId, input.userId),
        inArray(conceptTags.slug, [fromSlug, toSlug]),
      ),
    );
  const from = rows.find((row) => row.slug === fromSlug);
  let to = rows.find((row) => row.slug === toSlug);
  const now = Math.round(Date.now());

  if (!from) {
    throw new Error("Source concept tag not found.");
  }

  if (!to) {
    const [created] = await db
      .insert(conceptTags)
      .values({
        userId: input.userId,
        slug: toSlug,
        active: from.active,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: conceptTags.id, slug: conceptTags.slug, active: conceptTags.active });

    to = created;
  }

  await db
    .insert(questionConceptTags)
    .select(
      db
        .select({
          questionId: questionConceptTags.questionId,
          conceptTagId: sql<string>`${to.id}`.as("concept_tag_id"),
          createdAt: questionConceptTags.createdAt,
        })
        .from(questionConceptTags)
        .where(eq(questionConceptTags.conceptTagId, from.id)),
    )
    .onConflictDoNothing();

  await db.delete(conceptTags).where(eq(conceptTags.id, from.id));

  const tag = (await listConceptTags({ userId: input.userId })).find(
    (item) => item.slug === toSlug,
  );

  if (!tag) {
    throw new Error("Merged concept tag could not be loaded.");
  }

  return tag;
}

export async function getQuestionConceptSlugs(input: {
  userId: string;
  questionIds: string[];
}): Promise<Map<string, string[]>> {
  const questionIds = Array.from(new Set(input.questionIds)).filter(Boolean);

  if (questionIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      questionId: questionConceptTags.questionId,
      slug: conceptTags.slug,
    })
    .from(questionConceptTags)
    .innerJoin(conceptTags, eq(conceptTags.id, questionConceptTags.conceptTagId))
    .innerJoin(questions, eq(questions.id, questionConceptTags.questionId))
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(conceptTags.userId, input.userId),
        eq(decks.userId, input.userId),
        inArray(questionConceptTags.questionId, questionIds),
        visibleConceptTagClause(),
      ),
    )
    .orderBy(conceptTags.slug);
  const slugsByQuestionId = new Map<string, string[]>();

  for (const row of rows) {
    const slugs = slugsByQuestionId.get(row.questionId) ?? [];

    slugs.push(row.slug);
    slugsByQuestionId.set(row.questionId, slugs);
  }

  return slugsByQuestionId;
}

export async function questionHasActiveConceptTag(input: {
  userId: string;
  questionId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: questionConceptTags.questionId })
    .from(questionConceptTags)
    .innerJoin(conceptTags, eq(conceptTags.id, questionConceptTags.conceptTagId))
    .where(
      and(
        eq(questionConceptTags.questionId, input.questionId),
        eq(conceptTags.userId, input.userId),
        eq(conceptTags.active, true),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export function activeConceptEligibilityClause(userId: string) {
  return sql`exists (
    select 1
    from ${questionConceptTags}
    inner join ${conceptTags}
      on ${conceptTags.id} = ${questionConceptTags.conceptTagId}
    where ${questionConceptTags.questionId} = ${questions.id}
      and ${conceptTags.userId} = ${userId}
      and ${conceptTags.active} = true
  )`;
}

export async function countUntaggedQuestions(input: {
  userId: string;
}): Promise<number> {
  const [{ value = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .leftJoin(
      questionConceptTags,
      eq(questionConceptTags.questionId, questions.id),
    )
    .where(
      and(
        eq(decks.userId, input.userId),
        isNull(decks.archivedAt),
        isNull(questions.flaggedAt),
        isNull(questionConceptTags.questionId),
        lte(questions.nextDue, Math.round(Date.now())),
      ),
    );

  return Number(value) || 0;
}

export async function ensureFallbackConceptTagForDeck(input: {
  userId: string;
  deckId: string;
  slug: string;
}): Promise<void> {
  const slug = normalizeConceptSlug(input.slug);

  if (!isUsefulConceptSlug(slug)) {
    return;
  }

  const now = Math.round(Date.now());
  const [tag] = await db
    .insert(conceptTags)
    .values({
      userId: input.userId,
      slug,
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [conceptTags.userId, conceptTags.slug],
      set: {
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({ id: conceptTags.id });

  if (!tag) {
    return;
  }

  await db
    .insert(questionConceptTags)
    .select(
      db
        .select({
          questionId: questions.id,
          conceptTagId: sql<string>`${tag.id}`.as("concept_tag_id"),
          createdAt: questions.createdAt,
        })
        .from(questions)
        .innerJoin(decks, eq(decks.id, questions.deckId))
        .where(and(eq(decks.userId, input.userId), eq(questions.deckId, input.deckId))),
    )
    .onConflictDoNothing();
}
