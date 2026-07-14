export type OpenRouterUsageMetrics = {
  prompt_tokens?: unknown;
  prompt_tokens_details?: unknown;
  cache_read_tokens?: unknown;
  cached_tokens?: unknown;
  cache_write_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
};

export type PromptCacheMetrics = {
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  uncachedPromptTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitPercent: number | null;
};

export function toFiniteNumber(value: unknown): number | null {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : null;

  return numberValue !== null && Number.isFinite(numberValue)
    ? numberValue
    : null;
}

function readNumberProperty(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  return toFiniteNumber((source as Record<string, unknown>)[key]);
}

function firstFiniteNumber(...values: Array<unknown>): number | null {
  for (const value of values) {
    const numberValue = toFiniteNumber(value);

    if (numberValue !== null) {
      return numberValue;
    }
  }

  return null;
}

export function normalizeTokenCount(value: number | null): number | null {
  return value !== null && value >= 0 ? Math.round(value) : null;
}

export function promptCacheMetricsFromOpenRouterUsage(
  usage: OpenRouterUsageMetrics | undefined,
  promptTokensFallback: number | null = null,
): PromptCacheMetrics {
  const promptTokenDetails = usage?.prompt_tokens_details;
  const promptTokens =
    normalizeTokenCount(toFiniteNumber(usage?.prompt_tokens)) ??
    normalizeTokenCount(promptTokensFallback);
  const cachedPromptTokens = normalizeTokenCount(
    firstFiniteNumber(
      readNumberProperty(promptTokenDetails, "cached_tokens"),
      readNumberProperty(promptTokenDetails, "cache_read_tokens"),
      usage?.cache_read_tokens,
      usage?.cached_tokens,
    ),
  );
  const cacheWriteTokens = normalizeTokenCount(
    firstFiniteNumber(
      usage?.cache_write_tokens,
      usage?.cache_creation_input_tokens,
      readNumberProperty(promptTokenDetails, "cache_write_tokens"),
      readNumberProperty(promptTokenDetails, "cache_creation_input_tokens"),
    ),
  );
  const uncachedPromptTokens =
    promptTokens !== null && cachedPromptTokens !== null
      ? Math.max(0, promptTokens - cachedPromptTokens)
      : null;
  const cacheHitPercent =
    promptTokens !== null && promptTokens > 0 && cachedPromptTokens !== null
      ? (cachedPromptTokens / promptTokens) * 100
      : null;

  return {
    promptTokens,
    cachedPromptTokens,
    uncachedPromptTokens,
    cacheWriteTokens,
    cacheHitPercent,
  };
}
