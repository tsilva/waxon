export type CourseMessageMetrics = {
  cost: number | null;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  uncachedPromptTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitPercent: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  tokensPerSecond: number | null;
  contextWindowTokens: number | null;
  contextPercent: number | null;
};

function toFiniteNumber(value: unknown): number | null {
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

function readNumberProperty(
  source: unknown,
  key: string,
): number | null {
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

function normalizeTokenCount(value: number | null): number | null {
  return value !== null && value >= 0 ? Math.round(value) : null;
}

export function metricsFromOpenRouterUsage(
  usage: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: unknown;
    cache_read_tokens?: unknown;
    cached_tokens?: unknown;
    cache_write_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  } | undefined,
  latencyMs: number,
  contextWindowTokens: number | null = null,
): CourseMessageMetrics | null {
  const cost = toFiniteNumber(usage?.cost);
  const promptTokens = toFiniteNumber(usage?.prompt_tokens);
  const promptTokenDetails = usage?.prompt_tokens_details;
  const cachedPromptTokens = firstFiniteNumber(
    readNumberProperty(promptTokenDetails, "cached_tokens"),
    readNumberProperty(promptTokenDetails, "cache_read_tokens"),
    usage?.cache_read_tokens,
    usage?.cached_tokens,
  );
  const cacheWriteTokens = firstFiniteNumber(
    usage?.cache_write_tokens,
    usage?.cache_creation_input_tokens,
    readNumberProperty(promptTokenDetails, "cache_write_tokens"),
    readNumberProperty(promptTokenDetails, "cache_creation_input_tokens"),
  );
  const outputTokens = toFiniteNumber(usage?.completion_tokens);
  const totalTokens = toFiniteNumber(usage?.total_tokens);
  const roundedLatencyMs =
    Number.isFinite(latencyMs) && latencyMs > 0 ? Math.round(latencyMs) : null;
  const roundedPromptTokens = normalizeTokenCount(promptTokens);
  const roundedCachedPromptTokens = normalizeTokenCount(cachedPromptTokens);
  const roundedCacheWriteTokens = normalizeTokenCount(cacheWriteTokens);
  const uncachedPromptTokens =
    roundedPromptTokens !== null && roundedCachedPromptTokens !== null
      ? Math.max(0, roundedPromptTokens - roundedCachedPromptTokens)
      : null;
  const cacheHitPercent =
    roundedPromptTokens !== null &&
    roundedPromptTokens > 0 &&
    roundedCachedPromptTokens !== null
      ? (roundedCachedPromptTokens / roundedPromptTokens) * 100
      : null;
  const tokensPerSecond =
    outputTokens !== null && outputTokens > 0 && roundedLatencyMs !== null
      ? outputTokens / (roundedLatencyMs / 1000)
      : null;
  const roundedContextWindowTokens =
    contextWindowTokens !== null &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? Math.round(contextWindowTokens)
      : null;
  const contextPercent =
    promptTokens !== null &&
    promptTokens >= 0 &&
    roundedContextWindowTokens !== null
      ? (promptTokens / roundedContextWindowTokens) * 100
      : null;

  if (
    (cost === null || cost < 0) &&
    roundedCachedPromptTokens === null &&
    roundedCacheWriteTokens === null &&
    tokensPerSecond === null &&
    contextPercent === null
  ) {
    return null;
  }

  return {
    cost: cost !== null && cost >= 0 ? cost : null,
    promptTokens: roundedPromptTokens,
    cachedPromptTokens: roundedCachedPromptTokens,
    uncachedPromptTokens,
    cacheWriteTokens: roundedCacheWriteTokens,
    cacheHitPercent,
    outputTokens:
      outputTokens !== null && outputTokens >= 0 ? Math.round(outputTokens) : null,
    totalTokens:
      totalTokens !== null && totalTokens >= 0 ? Math.round(totalTokens) : null,
    latencyMs: roundedLatencyMs,
    tokensPerSecond,
    contextWindowTokens: roundedContextWindowTokens,
    contextPercent,
  };
}
