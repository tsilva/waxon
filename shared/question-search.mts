import { createHash } from "node:crypto";
import {
  buildOpenRouterHeaders,
  DEFAULT_QUESTION_SEARCH_EMBEDDING_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
  resolveOpenRouterApiKey,
  resolveQuestionSearchEmbeddingModel,
  type OpenRouterEnvironment,
} from "./openrouter-config.mts";

export const QUESTION_SEARCH_EMBEDDING_MODEL =
  DEFAULT_QUESTION_SEARCH_EMBEDDING_MODEL;
export const QUESTION_SEARCH_EMBEDDING_DIMENSIONS = 512;
export const QUESTION_SEARCH_EMBEDDING_VERSION = 1;
export const QUESTION_SEARCH_RRF_K = 60;
export const QUESTION_SEARCH_TRIGRAM_THRESHOLD = 0.3;

export type QuestionSearchConfiguredMode = "lexical" | "shadow" | "hybrid";
export type QuestionSearchMode =
  | "lexical"
  | "hybrid"
  | "lexical_fallback";
export type QuestionSearchAdvisory =
  | "exact_duplicate"
  | "review_similar"
  | "no_close_match"
  | "search_incomplete";

export function resolveQuestionSearchConfig(
  env: OpenRouterEnvironment = process.env,
): {
  mode: QuestionSearchConfiguredMode;
  model: string;
  semanticThreshold: number | null;
} {
  const configuredMode = env.WAXON_QUESTION_SEARCH_MODE?.trim().toLowerCase();
  const mode: QuestionSearchConfiguredMode =
    configuredMode === "shadow" || configuredMode === "hybrid"
      ? configuredMode
      : "lexical";
  const thresholdText =
    env.WAXON_QUESTION_SEARCH_SEMANTIC_THRESHOLD?.trim() ?? "";
  const thresholdValue = Number(thresholdText);
  const semanticThreshold =
    thresholdText.length > 0 &&
    Number.isFinite(thresholdValue) &&
    thresholdValue >= -1 &&
    thresholdValue <= 1
      ? thresholdValue
      : null;

  return {
    mode,
    model: resolveQuestionSearchEmbeddingModel(env),
    semanticThreshold,
  };
}

export function normalizeQuestionSearchPrompt(prompt: string): string {
  return prompt.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function questionSearchEmbeddingInput(prompt: string): string {
  return `Question:\n${normalizeQuestionSearchPrompt(prompt)}`;
}

export function questionSearchPromptHash(prompt: string): string {
  return createHash("sha256")
    .update(
      `${QUESTION_SEARCH_EMBEDDING_VERSION}\n${questionSearchEmbeddingInput(prompt)}`,
    )
    .digest("hex");
}

export function normalizeQuestionSearchEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== QUESTION_SEARCH_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Question-search embeddings must contain ${QUESTION_SEARCH_EMBEDDING_DIMENSIONS} values.`,
    );
  }
  const vector = value.map((item) => Number(item));
  if (vector.some((item) => !Number.isFinite(item))) {
    throw new Error("Question-search embeddings must contain only finite values.");
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, item) => sum + item * item, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Question-search embeddings must have non-zero magnitude.");
  }
  return vector.map((item) => item / magnitude);
}

export function questionSearchVectorLiteral(vector: readonly number[]): string {
  return `[${normalizeQuestionSearchEmbedding(vector).join(",")}]`;
}

export function reciprocalRankFuse<T extends string>(
  rankedLists: readonly (readonly T[])[],
  k = QUESTION_SEARCH_RRF_K,
): Array<{ id: T; score: number }> {
  const scores = new Map<T, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function questionSearchAdvisory(input: {
  exact: boolean;
  matchCount: number;
  semanticComplete: boolean;
}): QuestionSearchAdvisory {
  if (input.exact) return "exact_duplicate";
  if (input.matchCount > 0) return "review_similar";
  return input.semanticComplete ? "no_close_match" : "search_incomplete";
}

type EmbeddingsResponse = {
  data?: Array<{ embedding?: unknown; index?: number }>;
  usage?: {
    prompt_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
  };
};

export async function requestQuestionSearchEmbeddings(input: {
  prompts: readonly string[];
  userId: string;
  env?: OpenRouterEnvironment;
  signal?: AbortSignal;
}): Promise<{
  embeddings: number[][];
  model: string;
  usage: EmbeddingsResponse["usage"];
  responseBody: EmbeddingsResponse;
}> {
  if (input.prompts.length === 0) {
    return {
      embeddings: [],
      model: resolveQuestionSearchConfig(input.env).model,
      usage: undefined,
      responseBody: { data: [] },
    };
  }
  const env = input.env ?? process.env;
  const apiKey = resolveOpenRouterApiKey(env);
  if (!apiKey) {
    throw new Error(
      "Question-search embeddings are unavailable because no API key is configured.",
    );
  }
  const { model } = resolveQuestionSearchConfig(env);
  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey, env),
    body: JSON.stringify({
      model,
      dimensions: QUESTION_SEARCH_EMBEDDING_DIMENSIONS,
      encoding_format: "float",
      input: input.prompts.map(questionSearchEmbeddingInput),
      user: input.userId,
    }),
    signal: input.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Question-search embedding request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as EmbeddingsResponse;
  if (!Array.isArray(parsed.data) || parsed.data.length !== input.prompts.length) {
    throw new Error("Question-search embedding response had the wrong batch size.");
  }
  const ordered = [...parsed.data].sort(
    (left, right) => (left.index ?? 0) - (right.index ?? 0),
  );
  return {
    embeddings: ordered.map((item) =>
      normalizeQuestionSearchEmbedding(item.embedding),
    ),
    model,
    usage: parsed.usage,
    responseBody: parsed,
  };
}
