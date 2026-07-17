export const DEDUPE_EMBEDDING_DIMENSIONS: number;
export const DEDUPE_EMBEDDING_KIND: string;
export const DEDUPE_SOURCE_VERSION: number;

export type EmbeddingSourceInput = {
  question: string;
  conciseAnswer?: string;
  kind?: string;
  sourceVersion?: number;
};

export function normalizeEmbeddingText(value: string): string;
export function buildEmbeddingSource(input: EmbeddingSourceInput): string;
export function buildQuestionDedupeSource(input: {
  question: string;
  conciseAnswer: string;
}): string;
export function hashEmbeddingSource(source: string): string;
export function questionDedupeSourceHash(input: {
  question: string;
  conciseAnswer: string;
}): string;
export function decodeOpenRouterEmbeddings(
  data: unknown,
  options?: {
    expectedCount?: number;
    expectedDimensions?: number;
    allowEmpty?: boolean;
  },
): number[][];
