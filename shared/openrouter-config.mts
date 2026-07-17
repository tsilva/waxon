export const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_EMBEDDINGS_URL =
  "https://openrouter.ai/api/v1/embeddings";
export const DEFAULT_OPENROUTER_CHAT_MODEL = "google/gemini-3.5-flash";
export const DEFAULT_OPENROUTER_EVALUATION_MODEL = "google/gemini-3.5-flash";
export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";

export type OpenRouterEnvironment = Record<string, string | undefined>;

export function resolveOpenRouterApiKey(
  env: OpenRouterEnvironment = process.env,
): string | null {
  const apiKey = env.OPENROUTER_API_KEY ?? env.LLM_API_KEY ?? "";

  return apiKey.trim() || null;
}

export function resolveOpenRouterModel({
  env = process.env,
  variable,
  fallback,
  requireConfigured = false,
}: {
  env?: OpenRouterEnvironment;
  variable: string;
  fallback: string;
  requireConfigured?: boolean;
}): string | null {
  const model = env[variable]?.trim() ?? "";

  if (model) {
    return model;
  }

  return requireConfigured ? null : fallback;
}

export function resolveEmbeddingModel(
  env: OpenRouterEnvironment = process.env,
): string {
  return resolveOpenRouterModel({
    env,
    variable: "EMBEDDING_MODEL",
    fallback: DEFAULT_EMBEDDING_MODEL,
  }) as string;
}

export function buildOpenRouterHeaders(
  apiKey: string,
  env: OpenRouterEnvironment = process.env,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.OPENROUTER_REFERER ?? "http://localhost:3000",
    "X-Title": env.OPENROUTER_TITLE ?? "waxon",
  };
}
