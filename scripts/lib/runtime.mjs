export const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export function loadLocalEnvFiles(files = [".env", ".env.local"]) {
  for (const envFile of files) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // Missing env files are fine; CI can provide env vars directly.
    }
  }
}

export function configureNeonWebSocket(neonConfig) {
  if (typeof WebSocket !== "undefined") {
    neonConfig.webSocketConstructor = WebSocket;
  }
}

export function requireEnv(name, fallbackName) {
  const value = process.env[name] ?? process.env[fallbackName ?? ""];

  if (!value) {
    throw new Error(
      fallbackName
        ? `${name} or ${fallbackName} is required`
        : `${name} is required`,
    );
  }

  return value;
}

export function requireOpenRouterApiKey() {
  return requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");
}

export function openRouterChatModel() {
  return process.env.LLM_MODEL?.trim() || "google/gemini-3.5-flash";
}

export function openRouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "waxon",
  };
}

export async function fetchOpenRouterJson(
  url,
  { apiKey, body, errorPrefix, errorTextLength = 500 },
) {
  const response = await fetch(url, {
    method: "POST",
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `${errorPrefix}: ${response.status} ${response.statusText} ${errorText.slice(
        0,
        errorTextLength,
      )}`.trim(),
    );
  }

  return response.json();
}

export function extractOpenRouterChatText(body) {
  const content = body?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object") {
        return typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createDatabasePool(Pool) {
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");

  return new Pool({ connectionString });
}

export function logSavedProgress(saved, total) {
  console.log(`Saved ${saved}/${total}`);
}

export function chunks(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

export function vectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}
