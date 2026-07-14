export const OPENROUTER_CHAT_URL: string;
export const OPENROUTER_EMBEDDINGS_URL: string;
export const DEFAULT_OPENROUTER_CHAT_MODEL: string;
export const DEFAULT_OPENROUTER_EVALUATION_MODEL: string;
export const DEFAULT_EMBEDDING_MODEL: string;

export type OpenRouterEnvironment = Record<string, string | undefined>;

export function resolveOpenRouterApiKey(
  env?: OpenRouterEnvironment,
): string | null;

export function resolveOpenRouterModel(input: {
  env?: OpenRouterEnvironment;
  variable: string;
  fallback: string;
  requireConfigured?: boolean;
}): string | null;

export function resolveEmbeddingModel(env?: OpenRouterEnvironment): string;

export function buildOpenRouterHeaders(
  apiKey: string,
  env?: OpenRouterEnvironment,
): Record<string, string>;
