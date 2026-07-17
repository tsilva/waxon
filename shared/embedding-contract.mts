import { createHash } from "node:crypto";

export const DEDUPE_EMBEDDING_DIMENSIONS = 3072;
export const DEDUPE_EMBEDDING_KIND = "dedupe_v1";
export const DEDUPE_SOURCE_VERSION = 1;

export type EmbeddingSourceInput = {
  question: string;
  conciseAnswer?: string;
  kind?: string;
  sourceVersion?: number;
};

export function normalizeEmbeddingText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildEmbeddingSource({
  question,
  conciseAnswer = "",
  kind = DEDUPE_EMBEDDING_KIND,
  sourceVersion = DEDUPE_SOURCE_VERSION,
}: EmbeddingSourceInput): string {
  if (kind === "question_only") {
    return [
      `version: ${sourceVersion}`,
      "kind: question_only",
      `Question: ${normalizeEmbeddingText(question)}`,
    ].join("\n");
  }

  if (kind === DEDUPE_EMBEDDING_KIND) {
    if (!conciseAnswer.trim()) {
      throw new Error(
        `Question is missing concise answer for ${DEDUPE_EMBEDDING_KIND}: ${question}`,
      );
    }

    return [
      `version: ${sourceVersion}`,
      `kind: ${DEDUPE_EMBEDDING_KIND}`,
      `Question: ${normalizeEmbeddingText(question)}`,
      `Expected answer: ${normalizeEmbeddingText(conciseAnswer)}`,
    ].join("\n");
  }

  throw new Error(`Unsupported embedding kind: ${kind}`);
}

export function buildQuestionDedupeSource(input: {
  question: string;
  conciseAnswer: string;
}): string {
  return buildEmbeddingSource(input);
}

export function hashEmbeddingSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function questionDedupeSourceHash(input: {
  question: string;
  conciseAnswer: string;
}): string {
  return hashEmbeddingSource(buildQuestionDedupeSource(input));
}

export function decodeOpenRouterEmbeddings(
  data: unknown,
  {
    expectedCount,
    expectedDimensions,
    allowEmpty = false,
  }: {
    expectedCount?: number;
    expectedDimensions?: number;
    allowEmpty?: boolean;
  } = {},
): number[][] {
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter returned no embedding data.");
  }

  if (expectedCount !== undefined && data.length !== expectedCount) {
    throw new Error(
      `OpenRouter returned ${data.length} embeddings; expected ${expectedCount}.`,
    );
  }

  return data.map((item, index) => {
    const rawEmbedding = (item as { embedding?: unknown } | null | undefined)
      ?.embedding;

    if (
      !Array.isArray(rawEmbedding) ||
      (!allowEmpty && rawEmbedding.length === 0)
    ) {
      throw new Error(`Embedding ${index} is missing or empty.`);
    }

    if (
      expectedDimensions !== undefined &&
      rawEmbedding.length !== expectedDimensions
    ) {
      throw new Error(
        `Embedding ${index} has ${rawEmbedding.length} dimensions; expected ${expectedDimensions}.`,
      );
    }

    return rawEmbedding.map((component) => {
      const value = Number(component);

      if (!Number.isFinite(value)) {
        throw new Error(`Embedding ${index} contains a non-finite value.`);
      }

      return value;
    });
  });
}
