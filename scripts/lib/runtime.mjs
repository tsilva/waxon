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
