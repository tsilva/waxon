import { createHash } from "node:crypto";

export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
export const DEDUPE_EMBEDDING_DIMENSIONS = 3072;
export const DEDUPE_EMBEDDING_KIND = "dedupe_v1";
export const DEDUPE_SOURCE_VERSION = 1;

export type QuestionDedupeSource = {
  question: string;
  conciseAnswer: string;
};

export function normalizeEmbeddingText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildQuestionDedupeSource(input: QuestionDedupeSource): string {
  return [
    `version: ${DEDUPE_SOURCE_VERSION}`,
    `kind: ${DEDUPE_EMBEDDING_KIND}`,
    `Question: ${normalizeEmbeddingText(input.question)}`,
    `Expected answer: ${normalizeEmbeddingText(input.conciseAnswer)}`,
  ].join("\n");
}

export function hashEmbeddingSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function questionDedupeSourceHash(
  input: QuestionDedupeSource,
): string {
  return hashEmbeddingSource(buildQuestionDedupeSource(input));
}
