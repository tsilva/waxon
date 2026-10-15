export function agentBridgeBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const value = (env.AGENTBRIDGE_BASE_URL ?? "http://127.0.0.1:8082/api/v1").replace(/\/+$/, "");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.hostname === "openrouter.ai") {
    throw new Error("Configure an AgentBridge HTTP endpoint.");
  }
  return value;
}

export function agentBridgeModel(model: string): string {
  if (/^(codex|claudecode)\//.test(model) || /^openrouter\/[^/]+\/.+/.test(model) || model === "openrouter/default") return model;
  return `openrouter/${model}`;
}

export const DEFAULT_OPENROUTER_CHAT_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_OPENROUTER_EVALUATION_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
export const DEFAULT_QUESTION_SEARCH_EMBEDDING_MODEL =
  "openai/text-embedding-3-small";

export type OpenRouterEnvironment = Record<string, string | undefined>;

export function resolveOpenRouterApiKey(
  env: OpenRouterEnvironment = process.env,
): string | null {
  if (usesProductionProvider(env)) return env.OPENROUTER_API_KEY?.trim() || null;
  return env.AGENTBRIDGE_API_KEY?.trim() || "not-needed";
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
  if (usesProductionProvider(env) && ["LLM_MODEL", "LLM_LEARN_MODEL", "LLM_EVALUATION_MODEL"].includes(variable)) {
    return productionChatModel;
  }
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

export function resolveQuestionSearchEmbeddingModel(
  env: OpenRouterEnvironment = process.env,
): string {
  return resolveOpenRouterModel({
    env,
    variable: "QUESTION_SEARCH_EMBEDDING_MODEL",
    fallback: DEFAULT_QUESTION_SEARCH_EMBEDDING_MODEL,
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

export function usesProductionProvider(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
}

export const productionChatModel = "deepseek/deepseek-v4.1-flash";

export function providerBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return usesProductionProvider(env) ? "https://openrouter.ai/api/v1" : agentBridgeBaseUrl(env);
}

export function providerModel(model: string, env: Record<string, string | undefined> = process.env): string {
  if (!usesProductionProvider(env)) return agentBridgeModel(model);
  const direct = model.replace(/^openrouter\//, "");
  if (!/^[^/]+\/[^/]+$/.test(direct) || /^(codex|claudecode)\//.test(direct)) {
    throw new Error("Production requires a direct provider/model identifier.");
  }
  return direct;
}

export function providerApiKey(env: Record<string, string | undefined> = process.env): string {
  if (!usesProductionProvider(env)) return env.AGENTBRIDGE_API_KEY?.trim() || "not-needed";
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("Production requires its own OpenRouter API key.");
  return key;
}
