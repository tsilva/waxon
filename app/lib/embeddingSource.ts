import {
  DEFAULT_EMBEDDING_MODEL,
  resolveEmbeddingModel,
} from "../../shared/openrouter-config.mjs";
import {
  buildQuestionDedupeSource,
  decodeOpenRouterEmbeddings,
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  hashEmbeddingSource,
  normalizeEmbeddingText,
  questionDedupeSourceHash,
} from "../../shared/embedding-contract.mjs";
import {
  getOpenRouterApiKey,
  openRouterEmbeddings,
  type OpenRouterTraceContext,
} from "./openRouter";

export { DEFAULT_EMBEDDING_MODEL, resolveEmbeddingModel };
export {
  buildQuestionDedupeSource,
  decodeOpenRouterEmbeddings,
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  hashEmbeddingSource,
  normalizeEmbeddingText,
  questionDedupeSourceHash,
};

export async function requestEmbeddings(input: {
  texts: string[];
  trace: OpenRouterTraceContext;
  apiKey?: string;
  failureMode?: "throw" | "empty";
}): Promise<number[][]> {
  if (input.texts.length === 0) {
    return [];
  }

  try {
    const apiKey = input.apiKey ?? getOpenRouterApiKey();

    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
    }

    const { response, body } = await openRouterEmbeddings({
      apiKey,
      trace: input.trace,
      body: {
        model: resolveEmbeddingModel(),
        input: input.texts,
        encoding_format: "float",
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embedding request failed (${response.status}).`);
    }

    return decodeOpenRouterEmbeddings(body.data, {
      expectedCount: input.texts.length,
      expectedDimensions: DEDUPE_EMBEDDING_DIMENSIONS,
    });
  } catch (error) {
    if (input.failureMode === "empty") {
      return [];
    }

    throw error;
  }
}

const PLOT_PROJECTION_X_SIN = 1.37;
const PLOT_PROJECTION_X_COS = 2.11;
const PLOT_PROJECTION_Y_SIN = 2.73;
const PLOT_PROJECTION_Y_COS = 0.97;

export type EmbeddingPlotProjection = {
  x: number;
  y: number;
};

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
