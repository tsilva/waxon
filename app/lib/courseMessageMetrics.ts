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

const COURSE_MESSAGE_METRICS_PATTERN =
  /<!--\s*waxon:llm-metrics\s+([^>]*)-->\s*/gu;

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

function parseMetricAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(/([A-Za-z]+)=([^\s]+)/gu)) {
    const key = match[1];
    const value = match[2];

    if (key && value) {
      attributes[key] = value;
    }
  }

  return attributes;
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

export function appendCourseMessageMetrics(
  content: string,
  metrics: CourseMessageMetrics | null | undefined,
): string {
  if (!metrics) {
    return content;
  }

  const attributes = [
    metrics.cost !== null ? `cost=${metrics.cost.toFixed(8)}` : null,
    metrics.promptTokens !== null ? `promptTokens=${metrics.promptTokens}` : null,
    metrics.cachedPromptTokens !== null
      ? `cachedPromptTokens=${metrics.cachedPromptTokens}`
      : null,
    metrics.uncachedPromptTokens !== null
      ? `uncachedPromptTokens=${metrics.uncachedPromptTokens}`
      : null,
    metrics.cacheWriteTokens !== null
      ? `cacheWriteTokens=${metrics.cacheWriteTokens}`
      : null,
    metrics.cacheHitPercent !== null
      ? `cacheHitPercent=${metrics.cacheHitPercent.toFixed(4)}`
      : null,
    metrics.outputTokens !== null ? `outputTokens=${metrics.outputTokens}` : null,
    metrics.totalTokens !== null ? `totalTokens=${metrics.totalTokens}` : null,
    metrics.latencyMs !== null ? `latencyMs=${metrics.latencyMs}` : null,
    metrics.tokensPerSecond !== null
      ? `tokps=${metrics.tokensPerSecond.toFixed(2)}`
      : null,
    metrics.contextWindowTokens !== null
      ? `contextWindow=${metrics.contextWindowTokens}`
      : null,
    metrics.contextPercent !== null
      ? `contextPercent=${metrics.contextPercent.toFixed(4)}`
      : null,
  ].filter(Boolean);

  if (attributes.length === 0) {
    return content;
  }

  const strippedContent = stripCourseMessageMetrics(content).trimEnd();

  return `${strippedContent}\n\n<!-- waxon:llm-metrics ${attributes.join(" ")} -->`;
}

export function parseCourseMessageMetrics(content: string): {
  content: string;
  metrics: CourseMessageMetrics | null;
} {
  let metrics: CourseMessageMetrics | null = null;
  const cleanedContent = content.replace(
    COURSE_MESSAGE_METRICS_PATTERN,
    (_comment, attributeSource: string) => {
      const attributes = parseMetricAttributes(attributeSource);
      const cost = toFiniteNumber(attributes.cost);
      const promptTokens = toFiniteNumber(attributes.promptTokens);
      const cachedPromptTokens = toFiniteNumber(attributes.cachedPromptTokens);
      const parsedUncachedPromptTokens = toFiniteNumber(
        attributes.uncachedPromptTokens,
      );
      const cacheWriteTokens = toFiniteNumber(attributes.cacheWriteTokens);
      const parsedCacheHitPercent = toFiniteNumber(attributes.cacheHitPercent);
      const outputTokens = toFiniteNumber(attributes.outputTokens);
      const totalTokens = toFiniteNumber(attributes.totalTokens);
      const latencyMs = toFiniteNumber(attributes.latencyMs);
      const parsedTokensPerSecond = toFiniteNumber(attributes.tokps);
      const contextWindowTokens = toFiniteNumber(attributes.contextWindow);
      const parsedContextPercent = toFiniteNumber(attributes.contextPercent);
      const tokensPerSecond =
        parsedTokensPerSecond ??
        (outputTokens !== null && outputTokens > 0 && latencyMs !== null && latencyMs > 0
          ? outputTokens / (latencyMs / 1000)
          : null);
      const contextPercent =
        parsedContextPercent ??
        (promptTokens !== null &&
        promptTokens >= 0 &&
        contextWindowTokens !== null &&
        contextWindowTokens > 0
          ? (promptTokens / contextWindowTokens) * 100
          : null);
      const normalizedPromptTokens = normalizeTokenCount(promptTokens);
      const normalizedCachedPromptTokens = normalizeTokenCount(cachedPromptTokens);
      const uncachedPromptTokens =
        parsedUncachedPromptTokens !== null && parsedUncachedPromptTokens >= 0
          ? Math.round(parsedUncachedPromptTokens)
          : normalizedPromptTokens !== null &&
              normalizedCachedPromptTokens !== null
            ? Math.max(0, normalizedPromptTokens - normalizedCachedPromptTokens)
            : null;
      const cacheHitPercent =
        parsedCacheHitPercent ??
        (normalizedPromptTokens !== null &&
        normalizedPromptTokens > 0 &&
        normalizedCachedPromptTokens !== null
          ? (normalizedCachedPromptTokens / normalizedPromptTokens) * 100
          : null);

      metrics = {
        cost: cost !== null && cost >= 0 ? cost : null,
        promptTokens: normalizedPromptTokens,
        cachedPromptTokens: normalizedCachedPromptTokens,
        uncachedPromptTokens,
        cacheWriteTokens: normalizeTokenCount(cacheWriteTokens),
        cacheHitPercent,
        outputTokens:
          outputTokens !== null && outputTokens >= 0
            ? Math.round(outputTokens)
            : null,
        totalTokens:
          totalTokens !== null && totalTokens >= 0
            ? Math.round(totalTokens)
            : null,
        latencyMs:
          latencyMs !== null && latencyMs >= 0 ? Math.round(latencyMs) : null,
        tokensPerSecond,
        contextWindowTokens:
          contextWindowTokens !== null && contextWindowTokens > 0
            ? Math.round(contextWindowTokens)
            : null,
        contextPercent,
      };

      return "";
    },
  );

  return {
    content: cleanedContent.trim(),
    metrics,
  };
}

export function stripCourseMessageMetrics(content: string): string {
  return content.replace(COURSE_MESSAGE_METRICS_PATTERN, "").trim();
}
