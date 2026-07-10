export const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_EMBEDDINGS_URL =
  "https://openrouter.ai/api/v1/embeddings";
export const DEFAULT_OPENROUTER_CHAT_MODEL = "google/gemini-3.5-flash";
export const DEFAULT_OPENROUTER_LEARN_MODEL = "google/gemini-3.5-flash";
export const DEFAULT_OPENROUTER_EVALUATION_MODEL = "google/gemini-3.5-flash";
export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";

export function resolveOpenRouterApiKey(env = process.env) {
  const apiKey = env.OPENROUTER_API_KEY ?? env.LLM_API_KEY ?? "";

  return apiKey.trim() || null;
}

export function resolveOpenRouterModel({
  env = process.env,
  variable,
  fallback,
  requireConfigured = false,
}) {
  const model = env[variable]?.trim() ?? "";

  if (model) {
    return model;
  }

  return requireConfigured ? null : fallback;
}

export function resolveEmbeddingModel(env = process.env) {
  return env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
}

export function buildOpenRouterHeaders(apiKey, env = process.env) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.OPENROUTER_REFERER ?? "http://localhost:3000",
    "X-Title": env.OPENROUTER_TITLE ?? "waxon",
  };
}
