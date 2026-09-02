import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { getV2Client } from "../../db/v2/client.ts";
import { beginLlmTrace, finishLlmTrace } from "../llmTraceStore.ts";
import {
  QUESTION_SEARCH_TRIGRAM_THRESHOLD,
  questionSearchAdvisory,
  questionSearchVectorLiteral,
  reciprocalRankFuse,
  requestQuestionSearchEmbeddings,
  resolveQuestionSearchConfig,
  type QuestionSearchAdvisory,
  type QuestionSearchMode,
} from "../../../shared/question-search.mts";
import { questionPromptKey } from "./questionInput.ts";
import { activeEmbeddingSpace } from "./embeddingSpaces.ts";
import type {
  V2QuestionFlag,
  V2QuestionLifecycle,
} from "./types.ts";

type SearchCandidate = {
  candidateId: string;
  prompt: string;
  referenceAnswer: string;
};

type StoredSearchRow = {
  candidate_id: string;
  id: string;
  prompt: string;
  reference_answer: string;
  lifecycle: string;
  updated_at: Date;
  match_type?: "full_text" | "trigram";
  branch_rank?: number | string;
  score?: number | string;
};

type SemanticSearchRow = Omit<StoredSearchRow, "match_type"> & {
  semantic_rank: number | string;
  semantic_similarity: number | string;
};

type BatchTrigramRow = {
  candidate_id: string;
  match_candidate_id: string;
  similarity: number | string;
  branch_rank: number | string;
};

export type QuestionSearchMatch = {
  origin: "bank" | "batch";
  id: string;
  candidateId: string | null;
  prompt: string;
  referenceAnswer: string;
  lifecycle: V2QuestionLifecycle | null;
  flags: V2QuestionFlag[];
  updatedAt: string | null;
  matchTypes: Array<"exact" | "full_text" | "trigram" | "semantic">;
  exactPrompt: boolean;
  lexicalRank: number | null;
  semanticRank: number | null;
  combinedRank: number;
  trigramSimilarity: number | null;
  semanticSimilarity: number | null;
};

export type QuestionCheckResult = {
  candidateId: string;
  advisory: QuestionSearchAdvisory;
  searchMode: QuestionSearchMode;
  signals: { exact: boolean; lexical: boolean; semantic: boolean };
  matches: QuestionSearchMatch[];
};

type LexicalSignals = {
  row: StoredSearchRow;
  fullTextRank: number | null;
  trigramRank: number | null;
  trigramSimilarity: number | null;
};

function asLifecycle(value: string): V2QuestionLifecycle {
  if (value === "active" || value === "flagged" || value === "archived") {
    return value;
  }
  throw new Error(`Unknown Question lifecycle: ${value}`);
}

function queryText(prompt: string): string {
  return prompt.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

async function exactBankMatches(
  userId: string,
  candidates: readonly SearchCandidate[],
): Promise<Map<string, StoredSearchRow[]>> {
  const byKey = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = questionPromptKey(candidate.prompt);
    byKey.set(key, [...(byKey.get(key) ?? []), candidate.candidateId]);
  }
  const keys = [...byKey.keys()];
  if (keys.length === 0) return new Map();
  const result = await getV2Client().pool.query<
    Omit<StoredSearchRow, "candidate_id"> & { target_key: string }
  >(
    `SELECT q.id, q.target_key, q.prompt, q.reference_answer,
            q.lifecycle::text, q.updated_at
       FROM waxon_v2.questions q
      WHERE q.user_id = $1
        AND q.target_key = ANY($2::text[])
        AND q.lifecycle::text IN ('active','flagged','archived')`,
    [userId, keys],
  );
  const matches = new Map<string, StoredSearchRow[]>();
  for (const row of result.rows) {
    for (const candidateId of byKey.get(row.target_key) ?? []) {
      matches.set(candidateId, [
        ...(matches.get(candidateId) ?? []),
        { ...row, candidate_id: candidateId },
      ]);
    }
  }
  return matches;
}

async function lexicalRows(input: {
  userId: string;
  candidates: readonly SearchCandidate[];
  branchLimit: number;
  lifecycle?: V2QuestionLifecycle | null;
}): Promise<StoredSearchRow[]> {
  if (input.candidates.length === 0) return [];
  const candidates = input.candidates.map((candidate) => ({
    candidate_id: candidate.candidateId,
    query: queryText(candidate.prompt),
  }));
  const result = await getV2Client().pool.query<StoredSearchRow>(
    `WITH input AS (
       SELECT candidate_id, query
         FROM jsonb_to_recordset($2::jsonb)
           AS item(candidate_id text, query text)
     ), branches AS (
       SELECT input.candidate_id, hit.*, 'full_text'::text AS match_type
         FROM input
         CROSS JOIN LATERAL (
           SELECT q.id, q.prompt, q.reference_answer, q.lifecycle::text,
                  q.updated_at,
                  ts_rank_cd(
                    setweight(to_tsvector('simple', coalesce(q.prompt, '')), 'A') ||
                    setweight(to_tsvector('simple', coalesce(q.reference_answer, '')), 'B'),
                    websearch_to_tsquery('simple', input.query),
                    32
                  ) AS score
             FROM waxon_v2.questions q
            WHERE q.user_id = $1
              AND (
                $5::text IS NULL
                OR q.lifecycle::text = $5
              )
              AND q.lifecycle::text IN ('active','flagged','archived')
              AND (
                setweight(to_tsvector('simple', coalesce(q.prompt, '')), 'A') ||
                setweight(to_tsvector('simple', coalesce(q.reference_answer, '')), 'B')
              ) @@ websearch_to_tsquery('simple', input.query)
            ORDER BY score DESC, q.updated_at DESC, q.id
            LIMIT $3
         ) hit
       UNION ALL
       SELECT input.candidate_id, hit.*, 'trigram'::text AS match_type
         FROM input
         CROSS JOIN LATERAL (
           SELECT q.id, q.prompt, q.reference_answer, q.lifecycle::text,
                  q.updated_at, similarity(q.prompt, input.query) AS score
             FROM waxon_v2.questions q
            WHERE q.user_id = $1
              AND (
                $5::text IS NULL
                OR q.lifecycle::text = $5
              )
              AND q.lifecycle::text IN ('active','flagged','archived')
              AND similarity(q.prompt, input.query) >= $4
            ORDER BY q.prompt <-> input.query, q.updated_at DESC, q.id
            LIMIT $3
         ) hit
     )
     SELECT *, row_number() OVER (
       PARTITION BY candidate_id, match_type ORDER BY score DESC, updated_at DESC, id
     ) AS branch_rank
       FROM branches
      ORDER BY candidate_id, match_type, branch_rank`,
    [
      input.userId,
      JSON.stringify(candidates),
      input.branchLimit,
      QUESTION_SEARCH_TRIGRAM_THRESHOLD,
      input.lifecycle ?? null,
    ],
  );
  return result.rows;
}

async function batchTrigramRows(
  candidates: readonly SearchCandidate[],
  branchLimit: number,
): Promise<BatchTrigramRow[]> {
  if (candidates.length < 2) return [];
  const result = await getV2Client().pool.query<BatchTrigramRow>(
    `WITH input AS (
       SELECT candidate_id, prompt, ordinal
         FROM jsonb_to_recordset($1::jsonb)
           AS item(candidate_id text, prompt text, ordinal integer)
     ), ranked AS (
       SELECT later.candidate_id,
              earlier.candidate_id AS match_candidate_id,
              similarity(later.prompt, earlier.prompt) AS similarity,
              row_number() OVER (
                PARTITION BY later.candidate_id
                ORDER BY similarity(later.prompt, earlier.prompt) DESC,
                         earlier.ordinal
              ) AS branch_rank
         FROM input later
         JOIN input earlier ON earlier.ordinal < later.ordinal
        WHERE similarity(later.prompt, earlier.prompt) >= $2
     )
     SELECT * FROM ranked WHERE branch_rank <= $3
     ORDER BY candidate_id, branch_rank`,
    [
      JSON.stringify(
        candidates.map((candidate, index) => ({
          candidate_id: candidate.candidateId,
          prompt: queryText(candidate.prompt),
          ordinal: index,
        })),
      ),
      QUESTION_SEARCH_TRIGRAM_THRESHOLD,
      branchLimit,
    ],
  );
  return result.rows;
}

function lexicalByCandidate(
  candidates: readonly SearchCandidate[],
  rows: readonly StoredSearchRow[],
): Map<string, { rankedIds: string[]; signals: Map<string, LexicalSignals> }> {
  const output = new Map<
    string,
    { rankedIds: string[]; signals: Map<string, LexicalSignals> }
  >();
  for (const candidate of candidates) {
    const candidateRows = rows.filter(
      (row) => row.candidate_id === candidate.candidateId,
    );
    const fullText = candidateRows
      .filter((row) => row.match_type === "full_text")
      .sort((left, right) => Number(left.branch_rank) - Number(right.branch_rank));
    const trigram = candidateRows
      .filter((row) => row.match_type === "trigram")
      .sort((left, right) => Number(left.branch_rank) - Number(right.branch_rank));
    const rankedIds = reciprocalRankFuse([
      fullText.map((row) => row.id),
      trigram.map((row) => row.id),
    ]).map((entry) => entry.id);
    const signals = new Map<string, LexicalSignals>();
    for (const row of candidateRows) {
      const prior = signals.get(row.id);
      signals.set(row.id, {
        row,
        fullTextRank:
          row.match_type === "full_text"
            ? Number(row.branch_rank)
            : (prior?.fullTextRank ?? null),
        trigramRank:
          row.match_type === "trigram"
            ? Number(row.branch_rank)
            : (prior?.trigramRank ?? null),
        trigramSimilarity:
          row.match_type === "trigram"
            ? Number(row.score)
            : (prior?.trigramSimilarity ?? null),
      });
    }
    output.set(candidate.candidateId, { rankedIds, signals });
  }
  return output;
}

export async function embedQuestionSearchPrompts(
  userId: string,
  prompts: readonly string[],
): Promise<{ embeddings: number[][]; model: string }> {
  const config = resolveQuestionSearchConfig();
  const requestBody = {
    model: config.model,
    dimensions: 512,
    input: prompts,
  };
  const pending = beginLlmTrace({
    traceId: randomUUID(),
    operation: "question_search_embedding",
    model: config.model,
    question:
      prompts.length === 1
        ? prompts[0]
        : `${prompts.length} question-search prompts`,
    requestBody,
  });
  try {
    const result = await requestQuestionSearchEmbeddings({
      prompts,
      userId,
    });
    await finishLlmTrace(pending, {
      ok: true,
      responseBody: result.responseBody,
      usage: result.usage,
    });
    return { embeddings: result.embeddings, model: result.model };
  } catch (error) {
    await finishLlmTrace(pending, { ok: false, error });
    throw error;
  }
}

async function semanticRows(input: {
  userId: string;
  candidates: readonly SearchCandidate[];
  embeddings: readonly number[][];
  model: string;
  threshold: number;
  branchLimit: number;
}): Promise<SemanticSearchRow[]> {
  if (input.candidates.length === 0) return [];
  const space = activeEmbeddingSpace();
  if (input.model !== space.requestModel) return [];
  const vectors = input.candidates.map((candidate, index) => ({
    candidate_id: candidate.candidateId,
    embedding: questionSearchVectorLiteral(input.embeddings[index] ?? []),
  }));
  const result = await getV2Client().pool.query<SemanticSearchRow>(
    `WITH input AS (
       SELECT candidate_id, embedding::halfvec(512) AS embedding
         FROM jsonb_to_recordset($2::jsonb)
           AS item(candidate_id text, embedding text)
     )
     SELECT input.candidate_id, hit.*
       FROM input
       CROSS JOIN LATERAL (
         SELECT q.id, q.prompt, q.reference_answer, q.lifecycle::text,
                q.updated_at,
                -(qse.embedding <#> input.embedding) AS semantic_similarity,
                row_number() OVER (
                  ORDER BY qse.embedding <#> input.embedding, q.id
                ) AS semantic_rank
         FROM waxon_v2.question_embeddings qse
           JOIN waxon_v2.questions q
             ON q.user_id = qse.user_id AND q.id = qse.question_id
          WHERE qse.user_id = $1
            AND qse.space_id = $3
            AND -(qse.embedding <#> input.embedding) >= $4
            AND q.lifecycle::text IN ('active','flagged','archived')
          ORDER BY qse.embedding <#> input.embedding, q.id
          LIMIT $5
       ) hit`,
    [
      input.userId,
      JSON.stringify(vectors),
      space.id,
      input.threshold,
      input.branchLimit,
    ],
  );
  return result.rows;
}

async function semanticSearchComplete(
  userId: string,
  model: string,
): Promise<boolean> {
  const space = activeEmbeddingSpace();
  if (model !== space.requestModel) return false;
  const result = await getV2Client().pool.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1
         FROM waxon_v2.questions q
         LEFT JOIN waxon_v2.question_embeddings qse
           ON qse.user_id = q.user_id
          AND qse.question_id = q.id
          AND qse.space_id = $2
        WHERE q.user_id = $1
          AND q.lifecycle::text IN ('active','flagged','archived')
          AND qse.question_id IS NULL
        LIMIT 1
     ) AS complete`,
    [userId, space.id],
  );
  return result.rows[0]?.complete === true;
}

function bankMatch(input: {
  signal: LexicalSignals | null;
  semantic: SemanticSearchRow | null;
  lexicalRank: number | null;
  semanticRank: number | null;
  combinedRank: number;
}): QuestionSearchMatch {
  const row = input.signal?.row ?? input.semantic;
  if (!row) throw new Error("Question-search match is missing its stored row.");
  const matchTypes: QuestionSearchMatch["matchTypes"] = [];
  if (input.signal?.fullTextRank !== null && input.signal?.fullTextRank !== undefined) {
    matchTypes.push("full_text");
  }
  if (input.signal?.trigramRank !== null && input.signal?.trigramRank !== undefined) {
    matchTypes.push("trigram");
  }
  if (input.semantic) matchTypes.push("semantic");
  return {
    origin: "bank",
    id: row.id,
    candidateId: null,
    prompt: row.prompt,
    referenceAnswer: row.reference_answer,
    lifecycle: asLifecycle(row.lifecycle),
    flags: [],
    updatedAt: row.updated_at.toISOString(),
    matchTypes,
    exactPrompt: false,
    lexicalRank: input.lexicalRank,
    semanticRank: input.semanticRank,
    combinedRank: input.combinedRank,
    trigramSimilarity: input.signal?.trigramSimilarity ?? null,
    semanticSimilarity: input.semantic
      ? Number(input.semantic.semantic_similarity)
      : null,
  };
}

async function questionFlagsById(
  userId: string,
  questionIds: readonly string[],
): Promise<Map<string, V2QuestionFlag[]>> {
  if (questionIds.length === 0) return new Map();
  const result = await getV2Client().pool.query<{
    question_id: string;
    origin: V2QuestionFlag["origin"];
    reasons: string[];
    detail: string | null;
    created_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT question_id, origin::text, reasons, detail, created_at, resolved_at
       FROM waxon_v2.question_flags
      WHERE user_id = $1
        AND question_id = ANY($2::uuid[])
      ORDER BY created_at, id`,
    [userId, [...new Set(questionIds)]],
  );
  const flagsByQuestionId = new Map<string, V2QuestionFlag[]>();
  for (const row of result.rows) {
    flagsByQuestionId.set(row.question_id, [
      ...(flagsByQuestionId.get(row.question_id) ?? []),
      {
        origin: row.origin,
        reasons: row.reasons,
        detail: row.detail,
        createdAt: row.created_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
      },
    ]);
  }
  return flagsByQuestionId;
}

export async function checkQuestions(input: {
  userId: string;
  items: readonly SearchCandidate[];
  limitPerItem?: number;
}): Promise<{ results: QuestionCheckResult[] }> {
  if (input.items.length === 0 || input.items.length > 50) {
    throw new Error("Check between 1 and 50 questions at a time.");
  }
  const limit = Math.max(1, Math.min(50, input.limitPerItem ?? 5));
  const branchLimit = Math.min(100, Math.max(25, limit * 3));
  const candidateIds = new Set<string>();
  const candidates = input.items.map((item) => {
    const candidateId = item.candidateId.trim().slice(0, 200);
    const prompt = item.prompt.trim();
    if (!candidateId || candidateIds.has(candidateId)) {
      throw new Error("Each checked question needs a unique candidateId.");
    }
    if (!prompt || prompt.length > 16_384) {
      throw new Error("Each checked question needs a prompt of at most 16384 characters.");
    }
    candidateIds.add(candidateId);
    return { ...item, candidateId, prompt };
  });
  const exactBank = await exactBankMatches(input.userId, candidates);
  const exactBatch = new Map<string, SearchCandidate>();
  const firstByPromptKey = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    const key = questionPromptKey(candidate.prompt);
    const earlier = firstByPromptKey.get(key);
    if (earlier) exactBatch.set(candidate.candidateId, earlier);
    else firstByPromptKey.set(key, candidate);
  }
  const nonExact = candidates.filter(
    (candidate) =>
      !(exactBank.get(candidate.candidateId)?.length || exactBatch.has(candidate.candidateId)),
  );
  const config = resolveQuestionSearchConfig();
  const hybridConfigured =
    config.mode === "hybrid" && config.semanticThreshold !== null;
  const semanticRequested = config.mode === "shadow" || hybridConfigured;
  const lexicalPromise = lexicalRows({
    userId: input.userId,
    candidates: nonExact,
    branchLimit,
  });
  const semanticStartedAt = Date.now();
  let semanticResult:
    | {
        rows: SemanticSearchRow[];
        embeddingsByCandidate: Map<string, number[]>;
        complete: boolean;
        succeeded: true;
      }
    | {
        rows: [];
        embeddingsByCandidate: Map<string, number[]>;
        complete: false;
        succeeded: false;
      } = {
    rows: [],
    embeddingsByCandidate: new Map(),
    complete: false,
    succeeded: false,
  };
  const batchTrigramPromise = batchTrigramRows(candidates, branchLimit);
  if (semanticRequested && nonExact.length > 0) {
    try {
      const [{ embeddings, model }, complete] = await Promise.all([
        embedQuestionSearchPrompts(
          input.userId,
          nonExact.map((candidate) => candidate.prompt),
        ),
        semanticSearchComplete(input.userId, config.model),
      ]);
      semanticResult = {
        rows: await semanticRows({
          userId: input.userId,
          candidates: nonExact,
          embeddings,
          model,
          threshold:
            config.mode === "hybrid"
              ? (config.semanticThreshold ?? 1)
              : -1,
          branchLimit,
        }),
        embeddingsByCandidate: new Map(
          nonExact.map((candidate, index) => [
            candidate.candidateId,
            embeddings[index] ?? [],
          ]),
        ),
        complete,
        succeeded: true,
      };
    } catch (error) {
      if (typeof Sentry.captureException === "function") {
        Sentry.captureException(error, {
          tags: { surface: "question-search", stage: "semantic" },
        });
      }
    }
  }
  const lexical = lexicalByCandidate(nonExact, await lexicalPromise);
  const batchTrigram = await batchTrigramPromise;
  const semanticByCandidate = new Map<string, SemanticSearchRow[]>();
  for (const row of semanticResult.rows) {
    semanticByCandidate.set(row.candidate_id, [
      ...(semanticByCandidate.get(row.candidate_id) ?? []),
      row,
    ]);
  }
  if (config.mode === "shadow" && nonExact.length > 0) {
    let overlapAtTen = 0;
    for (const candidate of nonExact) {
      const lexicalIds = new Set(
        (lexical.get(candidate.candidateId)?.rankedIds ?? []).slice(0, 10),
      );
      overlapAtTen += (semanticByCandidate.get(candidate.candidateId) ?? [])
        .slice(0, 10)
        .filter((row) => lexicalIds.has(row.id)).length;
    }
    console.info(
      JSON.stringify({
        event: "question_search_shadow",
        queryCount: nonExact.length,
        lexicalMatchCount: [...lexical.values()].reduce(
          (sum, value) => sum + value.rankedIds.length,
          0,
        ),
        semanticMatchCount: semanticResult.rows.length,
        overlapAtTen,
        semanticMs: Date.now() - semanticStartedAt,
        semanticComplete: semanticResult.complete,
      }),
    );
  }
  const useHybrid =
    hybridConfigured && semanticResult.succeeded && semanticResult.complete;

  const results: QuestionCheckResult[] = candidates.map((candidate) => {
      const bankExact = exactBank.get(candidate.candidateId) ?? [];
      const batchExact = exactBatch.get(candidate.candidateId);
      if (bankExact.length > 0 || batchExact) {
        const matches: QuestionSearchMatch[] = [
          ...bankExact.map((row, index) => ({
            origin: "bank" as const,
            id: row.id,
            candidateId: null,
            prompt: row.prompt,
            referenceAnswer: row.reference_answer,
            lifecycle: asLifecycle(row.lifecycle),
            flags: [],
            updatedAt: row.updated_at.toISOString(),
            matchTypes: ["exact" as const],
            exactPrompt: true,
            lexicalRank: null,
            semanticRank: null,
            combinedRank: index + 1,
            trigramSimilarity: null,
            semanticSimilarity: null,
          })),
          ...(batchExact
            ? [
                {
                  origin: "batch" as const,
                  id: batchExact.candidateId,
                  candidateId: batchExact.candidateId,
                  prompt: batchExact.prompt,
                  referenceAnswer: batchExact.referenceAnswer,
                  lifecycle: null,
                  flags: [],
                  updatedAt: null,
                  matchTypes: ["exact" as const],
                  exactPrompt: true,
                  lexicalRank: null,
                  semanticRank: null,
                  combinedRank: bankExact.length + 1,
                  trigramSimilarity: null,
                  semanticSimilarity: null,
                },
              ]
            : []),
        ];
        return {
          candidateId: candidate.candidateId,
          advisory: "exact_duplicate" as const,
          searchMode: "lexical" as const,
          signals: { exact: true, lexical: false, semantic: false },
          matches: matches.slice(0, limit),
        };
      }

      const lexicalResult = lexical.get(candidate.candidateId) ?? {
        rankedIds: [],
        signals: new Map<string, LexicalSignals>(),
      };
      const semanticRowsForCandidate = (
        semanticByCandidate.get(candidate.candidateId) ?? []
      ).sort(
        (left, right) =>
          Number(left.semantic_rank) - Number(right.semantic_rank),
      );
      const semanticIds = semanticRowsForCandidate.map((row) => row.id);
      const rankedIds = useHybrid
        ? reciprocalRankFuse([lexicalResult.rankedIds, semanticIds]).map(
            (entry) => entry.id,
          )
        : lexicalResult.rankedIds;
      const bankMatches = rankedIds.slice(0, limit).map((id, index) => {
        const lexicalRank = lexicalResult.rankedIds.indexOf(id);
        const semanticRank = semanticIds.indexOf(id);
        return bankMatch({
          signal: lexicalResult.signals.get(id) ?? null,
          semantic:
            semanticRank >= 0 ? (semanticRowsForCandidate[semanticRank] ?? null) : null,
          lexicalRank: lexicalRank >= 0 ? lexicalRank + 1 : null,
          semanticRank: semanticRank >= 0 ? semanticRank + 1 : null,
          combinedRank: index + 1,
        });
      });
      const batchTrigramForCandidate = batchTrigram
        .filter((row) => row.candidate_id === candidate.candidateId)
        .sort((left, right) => Number(left.branch_rank) - Number(right.branch_rank));
      const batchLexicalIds = batchTrigramForCandidate.map(
        (row) => row.match_candidate_id,
      );
      const currentEmbedding = semanticResult.embeddingsByCandidate.get(
        candidate.candidateId,
      );
      const currentIndex = candidates.findIndex(
        (item) => item.candidateId === candidate.candidateId,
      );
      const batchSemanticScores = useHybrid && currentEmbedding
        ? candidates
            .slice(0, currentIndex)
            .flatMap((earlier) => {
              const earlierEmbedding = semanticResult.embeddingsByCandidate.get(
                earlier.candidateId,
              );
              if (!earlierEmbedding) return [];
              const similarity = currentEmbedding.reduce(
                (sum, value, index) =>
                  sum + value * (earlierEmbedding[index] ?? 0),
                0,
              );
              return similarity >= (config.semanticThreshold ?? 1)
                ? [{ candidateId: earlier.candidateId, similarity }]
                : [];
            })
            .sort(
              (left, right) =>
                right.similarity - left.similarity ||
                left.candidateId.localeCompare(right.candidateId),
            )
        : [];
      const batchSemanticIds = batchSemanticScores.map(
        (item) => item.candidateId,
      );
      const batchRankedIds = useHybrid
        ? reciprocalRankFuse([batchLexicalIds, batchSemanticIds]).map(
            (entry) => entry.id,
          )
        : batchLexicalIds;
      const batchMatches = batchRankedIds.map((candidateId, index) => {
        const earlier = candidates.find(
          (item) => item.candidateId === candidateId,
        );
        if (!earlier) {
          throw new Error("Question-search batch match is missing its candidate.");
        }
        const lexicalRank = batchLexicalIds.indexOf(candidateId);
        const semanticRank = batchSemanticIds.indexOf(candidateId);
        return {
          origin: "batch" as const,
          id: earlier.candidateId,
          candidateId: earlier.candidateId,
          prompt: earlier.prompt,
          referenceAnswer: earlier.referenceAnswer,
          lifecycle: null,
          flags: [],
          updatedAt: null,
          matchTypes: [
            ...(lexicalRank >= 0 ? (["trigram"] as const) : []),
            ...(semanticRank >= 0 ? (["semantic"] as const) : []),
          ],
          exactPrompt: false,
          lexicalRank: lexicalRank >= 0 ? lexicalRank + 1 : null,
          semanticRank: semanticRank >= 0 ? semanticRank + 1 : null,
          combinedRank: index + 1,
          trigramSimilarity:
            lexicalRank >= 0
              ? Number(batchTrigramForCandidate[lexicalRank]?.similarity)
              : null,
          semanticSimilarity:
            semanticRank >= 0
              ? (batchSemanticScores[semanticRank]?.similarity ?? null)
              : null,
        } satisfies QuestionSearchMatch;
      });
      const matches = [...batchMatches, ...bankMatches]
        .slice(0, limit)
        .map((match, index) => ({ ...match, combinedRank: index + 1 }));
      const semanticComplete = useHybrid;
      const searchMode: QuestionSearchMode = useHybrid
        ? "hybrid"
        : config.mode === "hybrid"
          ? "lexical_fallback"
          : "lexical";
      return {
        candidateId: candidate.candidateId,
        advisory: questionSearchAdvisory({
          exact: false,
          matchCount: matches.length,
          semanticComplete,
        }),
        searchMode,
        signals: {
          exact: true,
          lexical: true,
          semantic: semanticComplete,
        },
        matches,
      };
    });
  const flagsByQuestionId = await questionFlagsById(
    input.userId,
    results.flatMap((result) =>
      result.matches
        .filter((match) => match.origin === "bank")
        .map((match) => match.id),
    ),
  );
  return {
    results: results.map((result) => ({
      ...result,
      matches: result.matches.map((match) =>
        match.origin === "bank"
          ? { ...match, flags: flagsByQuestionId.get(match.id) ?? [] }
          : match,
      ),
    })),
  };
}

export async function rankQuestionIdsLexically(input: {
  userId: string;
  query: string;
  lifecycle?: V2QuestionLifecycle | null;
  limit: number;
}): Promise<string[]> {
  const branchLimit = Math.min(100, Math.max(25, input.limit * 3));
  const candidate = {
    candidateId: "library-query",
    prompt: input.query,
    referenceAnswer: "",
  };
  const [exact, rows] = await Promise.all([
    getV2Client().pool.query<{ id: string }>(
      `SELECT id
         FROM waxon_v2.questions
        WHERE user_id = $1
          AND target_key = $2
          AND (
            $3::text IS NULL
            OR lifecycle::text = $3
          )
          AND lifecycle::text IN ('active','flagged','archived')
        ORDER BY updated_at DESC, id`,
      [input.userId, questionPromptKey(input.query), input.lifecycle ?? null],
    ),
    lexicalRows({
      userId: input.userId,
      candidates: [candidate],
      branchLimit,
      lifecycle: input.lifecycle,
    }),
  ]);
  const lexicalIds =
    lexicalByCandidate([candidate], rows).get(candidate.candidateId)?.rankedIds ??
    [];
  const exactIds = exact.rows.map((row) => row.id);
  return [...exactIds, ...lexicalIds.filter((id) => !exactIds.includes(id))].slice(
    0,
    input.limit,
  );
}
