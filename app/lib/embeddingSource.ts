import { createHash } from "node:crypto";

export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
export const DEDUPE_EMBEDDING_DIMENSIONS = 3072;
export const DEDUPE_EMBEDDING_KIND = "dedupe_v1";
export const DEDUPE_SOURCE_VERSION = 1;

const PLOT_PROJECTION_X_SIN = 1.37;
const PLOT_PROJECTION_X_COS = 2.11;
const PLOT_PROJECTION_Y_SIN = 2.73;
const PLOT_PROJECTION_Y_COS = 0.97;

export type EmbeddingPlotProjection = {
  x: number;
  y: number;
};

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

export function projectEmbeddingForPlot(
  embedding: number[],
): EmbeddingPlotProjection | null {
  if (embedding.length === 0) {
    return null;
  }

  let x = 0;
  let y = 0;

  for (let index = 0; index < embedding.length; index += 1) {
    const component = embedding[index] ?? 0;

    if (!Number.isFinite(component)) {
      throw new Error("Embedding components must be finite numbers");
    }

    const dimension = index + 1;

    x +=
      component *
      (Math.sin(dimension * PLOT_PROJECTION_X_SIN) +
        Math.cos(dimension * PLOT_PROJECTION_X_COS));
    y +=
      component *
      (Math.sin(dimension * PLOT_PROJECTION_Y_SIN) -
        Math.cos(dimension * PLOT_PROJECTION_Y_COS));
  }

  const scale = Math.sqrt(embedding.length);

  return {
    x: x / scale,
    y: y / scale,
  };
}
