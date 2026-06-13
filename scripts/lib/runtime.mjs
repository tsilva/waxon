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
