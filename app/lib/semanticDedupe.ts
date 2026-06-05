import { pool } from "@/app/db/client";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
  openRouterEmbeddings,
  type OpenRouterTraceContext,
} from "./openRouter";
import { questionSlug } from "./questionSlug";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
  buildQuestionDedupeSource,
  questionDedupeSourceHash,
} from "./embeddingSource";
import { generateConciseAnswers } from "./conciseAnswer";
import { readQuestions, type QuestionInput } from "./postgresStore";

export type NovelQuestionCandidate = {
  question: string;
  conciseAnswer: string;
};

export type AcceptedQuestionCandidate = NovelQuestionCandidate & {
  embedding: number[];
  sourceHash: string;
};

export type RejectedQuestionCandidate = NovelQuestionCandidate & {
  duplicateOf: string;
  rationale: string;
};

export type NovelQuestionGateResult = {
  accepted: AcceptedQuestionCandidate[];
  rejected: RejectedQuestionCandidate[];
};

type CandidateWithEmbedding = AcceptedQuestionCandidate & {
  id: string;
  slug: string;
};

type Neighbor = {
  id: string;
  kind: "existing" | "candidate";
  question: string;
  conciseAnswer: string;
  similarity: number;
};

type CandidateForJudgment = CandidateWithEmbedding & {
  neighbors: Neighbor[];
};

const DEFAULT_DECK_ID = "deep-learning";
const NEIGHBOR_COUNT = 10;
const MIN_EXTERNAL_SIMILARITY = 0.78;
const MIN_BATCH_SIMILARITY = 0.86;
const JUDGE_BATCH_SIZE = 10;

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function normalizeQuestionInput(
  input: Array<string | QuestionInput>,
): NovelQuestionCandidate[] {
  const seen = new Set<string>();
  const normalized: NovelQuestionCandidate[] = [];

  for (const item of input) {
    const question = typeof item === "string" ? item : item.question;
    const normalizedQuestion = question.trim().replace(/\s+/g, " ");
    const slug = questionSlug(normalizedQuestion);

    if (!normalizedQuestion || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    normalized.push({
      question: normalizedQuestion,
      conciseAnswer:
        typeof item === "string"
          ? ""
          : (item.conciseAnswer ?? "").trim().replace(/\s+/g, " "),
    });
  }

  return normalized;
}

function dotProduct(left: number[], right: number[]): number {
  let dot = 0;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
  }

  return dot;
}

function magnitude(vector: number[]): number {
  return Math.sqrt(vector.reduce((total, component) => total + component ** 2, 0));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const denominator = magnitude(left) * magnitude(right);

  if (denominator <= Number.EPSILON) {
    return 0;
  }

  return dotProduct(left, right) / denominator;
}

function extractJsonObject(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(match[0]);
  }
}

async function fetchEmbeddings(
  input: string[],
  trace: Partial<OpenRouterTraceContext>,
): Promise<number[][]> {
  if (input.length === 0) {
    return [];
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  }

  const { response, body } = await openRouterEmbeddings({
    apiKey,
    trace: {
      operation: trace.operation ?? "semantic_dedupe_embedding",
      userId: trace.userId,
      deckId: trace.deckId,
      question: trace.question,
    },
    body: {
      model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input,
      encoding_format: "float",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter embedding request failed (${response.status}).`);
  }

  if (!Array.isArray(body.data) || body.data.length !== input.length) {
    throw new Error("OpenRouter returned an unexpected embedding response.");
  }

  return body.data.map((item: { embedding?: unknown }, index: number) => {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error(`Embedding ${index} is missing or empty.`);
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

async function ensureConciseAnswers(
  candidates: NovelQuestionCandidate[],
  trace: Partial<OpenRouterTraceContext>,
): Promise<NovelQuestionCandidate[]> {
  const missing = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((item) => !item.candidate.conciseAnswer);

  if (missing.length === 0) {
    return candidates;
  }

  const generated = await generateConciseAnswers(
    missing.map((item) => ({
      id: String(item.index),
      question: item.candidate.question,
    })),
    {
      operation: trace.operation ?? "semantic_dedupe_concise_answer",
      userId: trace.userId,
      deckId: trace.deckId,
      question: trace.question,
    },
  );
  const generatedById = new Map(
    generated.map((item) => [item.id, item.conciseAnswer]),
  );

  return candidates.map((candidate, index) => ({
    ...candidate,
    conciseAnswer: candidate.conciseAnswer || generatedById.get(String(index)) || "",
  }));
}

async function buildCandidateEmbeddings(
  candidates: NovelQuestionCandidate[],
  trace: Partial<OpenRouterTraceContext>,
): Promise<CandidateWithEmbedding[]> {
  const sources = candidates.map((candidate) =>
    buildQuestionDedupeSource(candidate),
  );
  const embeddings = await fetchEmbeddings(sources, {
    operation: trace.operation ?? "semantic_dedupe_embedding",
    userId: trace.userId,
    deckId: trace.deckId,
    question: trace.question,
  });

  return candidates.map((candidate, index) => ({
    ...candidate,
    id: `candidate-${index + 1}`,
    slug: questionSlug(candidate.question),
    embedding: embeddings[index] ?? [],
    sourceHash: questionDedupeSourceHash(candidate),
  }));
}

async function loadExternalNeighbors(
  candidates: CandidateWithEmbedding[],
  trace: Partial<OpenRouterTraceContext>,
): Promise<Map<string, Neighbor[]>> {
  if (candidates.length === 0) {
    return new Map();
  }

  const deckId = trace.deckId?.trim() || DEFAULT_DECK_ID;
  const valuesSql = candidates
    .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}::vector)`)
    .join(", ");
  const params: unknown[] = [];

  for (const candidate of candidates) {
    params.push(candidate.id, vectorLiteral(candidate.embedding));
  }

  params.push(
    deckId,
    process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    DEDUPE_EMBEDDING_KIND,
    DEDUPE_SOURCE_VERSION,
    NEIGHBOR_COUNT,
  );

  const deckParam = params.length - 4;
  const modelParam = params.length - 3;
  const kindParam = params.length - 2;
  const versionParam = params.length - 1;
  const limitParam = params.length;

  const result = await pool.query(
    `
      WITH candidates(candidate_id, embedding) AS (
        VALUES ${valuesSql}
      )
      SELECT
        c.candidate_id,
        q.question,
        q.concise_answer,
        qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> c.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS}) AS distance
      FROM candidates c
      CROSS JOIN LATERAL (
        SELECT qe.question_id, qe.question, qe.embedding
        FROM question_embeddings qe
        WHERE qe.deck_id = $${deckParam}
          AND qe.embedding_model = $${modelParam}
          AND qe.embedding_kind = $${kindParam}
          AND qe.source_version = $${versionParam}
          AND qe.is_current = true
          AND qe.source_hash <> ''
        ORDER BY qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> c.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
        LIMIT $${limitParam}
      ) qe
      JOIN questions q ON q.id = qe.question_id
      ORDER BY c.candidate_id ASC, distance ASC
    `,
    params,
  );
  const neighborsByCandidate = new Map<string, Neighbor[]>();

  for (const row of result.rows as Array<{
    candidate_id: string;
    question: string;
    concise_answer: string;
    distance: number | string;
  }>) {
    const similarity = 1 - Number(row.distance);

    if (similarity < MIN_EXTERNAL_SIMILARITY) {
      continue;
    }

    const neighbors = neighborsByCandidate.get(row.candidate_id) ?? [];
    neighbors.push({
      id: row.question,
      kind: "existing",
      question: row.question,
      conciseAnswer: row.concise_answer,
      similarity: Number(similarity.toFixed(4)),
    });
    neighborsByCandidate.set(row.candidate_id, neighbors);
  }

  return neighborsByCandidate;
}

function addBatchNeighbors(
  candidates: CandidateForJudgment[],
): CandidateForJudgment[] {
  return candidates.map((candidate, index) => {
    const batchNeighbors: Neighbor[] = [];

    for (let otherIndex = 0; otherIndex < candidates.length; otherIndex += 1) {
      if (otherIndex === index) {
        continue;
      }

      const other = candidates[otherIndex];

      if (!other) {
        continue;
      }

      const similarity = cosineSimilarity(candidate.embedding, other.embedding);

      if (similarity >= MIN_BATCH_SIMILARITY) {
        batchNeighbors.push({
          id: other.id,
          kind: "candidate",
          question: other.question,
          conciseAnswer: other.conciseAnswer,
          similarity: Number(similarity.toFixed(4)),
        });
      }
    }

    return {
      ...candidate,
      neighbors: [...candidate.neighbors, ...batchNeighbors]
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, NEIGHBOR_COUNT),
    };
  });
}

async function judgeDuplicateBatch(
  candidates: CandidateForJudgment[],
  trace: Partial<OpenRouterTraceContext>,
): Promise<Map<string, { duplicateOf: string | null; rationale: string }>> {
  const candidatesWithNeighbors = candidates.filter(
    (candidate) => candidate.neighbors.length > 0,
  );
  const decisions = new Map<string, { duplicateOf: string | null; rationale: string }>();

  for (const candidate of candidates) {
    if (candidate.neighbors.length === 0) {
      decisions.set(candidate.id, {
        duplicateOf: null,
        rationale: "No close semantic neighbors found.",
      });
    }
  }

  if (candidatesWithNeighbors.length === 0) {
    return decisions;
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  }

  for (
    let offset = 0;
    offset < candidatesWithNeighbors.length;
    offset += JUDGE_BATCH_SIZE
  ) {
    const batch = candidatesWithNeighbors.slice(offset, offset + JUDGE_BATCH_SIZE);
    const { response, body } = await openRouterChatCompletion({
      apiKey,
      trace: {
        operation: trace.operation ?? "semantic_dedupe_judge",
        userId: trace.userId,
        deckId: trace.deckId,
        question: trace.question,
      },
      body: {
        model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: Math.min(4096, 220 * batch.length + 500),
        messages: [
          {
            role: "user",
            content: [
              "Decide whether generated flashcard candidates are semantic duplicates of close neighbors.",
              "Reject only when the candidate and a neighbor test the same atomic recall target, so mastering one would make the other redundant.",
              "Similar topic is not enough. Keep contrast pairs, prerequisite variants, examples with materially different reasoning, boundary cases, and failure-mode questions.",
              "Return strict JSON: {\"decisions\":[{\"candidateId\":\"...\",\"duplicateOf\":\"neighbor id or null\",\"rationale\":\"short\"}]}",
              JSON.stringify({
                candidates: batch.map((candidate) => ({
                  id: candidate.id,
                  question: candidate.question,
                  conciseAnswer: candidate.conciseAnswer,
                  neighbors: candidate.neighbors.map((neighbor) => ({
                    id: neighbor.id,
                    kind: neighbor.kind,
                    question: neighbor.question,
                    conciseAnswer: neighbor.conciseAnswer,
                    similarity: neighbor.similarity,
                  })),
                })),
              }),
            ].join("\n\n"),
          },
        ],
      },
    });

    if (!response.ok) {
      throw new Error(`Semantic duplicate judge failed (${response.status}).`);
    }

    const content = extractChatCompletionText(body);
    const parsed = extractJsonObject(content) as { decisions?: unknown };

    if (!Array.isArray(parsed.decisions)) {
      throw new Error("Semantic duplicate judge returned no decisions.");
    }

    for (const item of parsed.decisions) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const candidateId =
        typeof record.candidateId === "string" ? record.candidateId : "";
      const duplicateOf =
        typeof record.duplicateOf === "string" && record.duplicateOf.trim()
          ? record.duplicateOf.trim()
          : null;

      if (!candidateId) {
        continue;
      }

      decisions.set(candidateId, {
        duplicateOf,
        rationale:
          typeof record.rationale === "string" && record.rationale.trim()
            ? record.rationale.trim()
            : duplicateOf
              ? "Semantic duplicate."
              : "Semantically novel.",
      });
    }
  }

  return decisions;
}

export async function gateNovelQuestions(
  input: Array<string | QuestionInput>,
  trace: Partial<OpenRouterTraceContext> = {},
): Promise<NovelQuestionGateResult> {
  const normalized = await ensureConciseAnswers(normalizeQuestionInput(input), trace);
  const candidatesWithAnswers = normalized.filter(
    (candidate) => candidate.conciseAnswer.trim().length > 0,
  );
  const rejected: RejectedQuestionCandidate[] = normalized
    .filter((candidate) => !candidate.conciseAnswer.trim())
    .map((candidate) => ({
      ...candidate,
      duplicateOf: "",
      rationale: "Missing concise answer.",
    }));

  if (candidatesWithAnswers.length === 0) {
    return { accepted: [], rejected };
  }

  const existingQuestions = await readQuestions(
    trace.userId ? { userId: trace.userId } : {},
  );
  const existingBySlug = new Map(
    existingQuestions.map((row) => [questionSlug(row.question), row.question]),
  );
  const candidatesToCheck = candidatesWithAnswers.filter((candidate) => {
    const duplicate = existingBySlug.get(questionSlug(candidate.question));

    if (duplicate) {
      rejected.push({
        ...candidate,
        duplicateOf: duplicate,
        rationale: "Exact question duplicate.",
      });
      return false;
    }

    return true;
  });

  const embeddedCandidates = await buildCandidateEmbeddings(candidatesToCheck, trace);
  const externalNeighbors = await loadExternalNeighbors(embeddedCandidates, trace);
  const candidatesForJudgment = addBatchNeighbors(
    embeddedCandidates.map((candidate) => ({
      ...candidate,
      neighbors: externalNeighbors.get(candidate.id) ?? [],
    })),
  );
  const decisions = await judgeDuplicateBatch(candidatesForJudgment, trace);
  const rejectedCandidateIds = new Set<string>();
  const accepted: AcceptedQuestionCandidate[] = [];

  for (const candidate of candidatesForJudgment) {
    const decision = decisions.get(candidate.id);
    const duplicateOf = decision?.duplicateOf;

    if (duplicateOf && !rejectedCandidateIds.has(duplicateOf)) {
      rejected.push({
        question: candidate.question,
        conciseAnswer: candidate.conciseAnswer,
        duplicateOf,
        rationale: decision.rationale,
      });
      rejectedCandidateIds.add(candidate.id);
      continue;
    }

    accepted.push({
      question: candidate.question,
      conciseAnswer: candidate.conciseAnswer,
      embedding: candidate.embedding,
      sourceHash: candidate.sourceHash,
    });
  }

  return { accepted, rejected };
}
