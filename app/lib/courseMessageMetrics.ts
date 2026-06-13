export type CourseMessageMetrics = {
  cost: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  tokensPerSecond: number | null;
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

export function metricsFromOpenRouterUsage(
  usage: {
    completion_tokens?: unknown;
    cost?: unknown;
  } | undefined,
  latencyMs: number,
): CourseMessageMetrics | null {
  const cost = toFiniteNumber(usage?.cost);
  const outputTokens = toFiniteNumber(usage?.completion_tokens);
  const roundedLatencyMs =
    Number.isFinite(latencyMs) && latencyMs > 0 ? Math.round(latencyMs) : null;
  const tokensPerSecond =
    outputTokens !== null && outputTokens > 0 && roundedLatencyMs !== null
      ? outputTokens / (roundedLatencyMs / 1000)
      : null;

  if ((cost === null || cost < 0) && tokensPerSecond === null) {
    return null;
  }

  return {
    cost: cost !== null && cost >= 0 ? cost : null,
    outputTokens:
      outputTokens !== null && outputTokens >= 0 ? Math.round(outputTokens) : null,
    latencyMs: roundedLatencyMs,
    tokensPerSecond,
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
    metrics.outputTokens !== null ? `outputTokens=${metrics.outputTokens}` : null,
    metrics.latencyMs !== null ? `latencyMs=${metrics.latencyMs}` : null,
    metrics.tokensPerSecond !== null
      ? `tokps=${metrics.tokensPerSecond.toFixed(2)}`
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
      const outputTokens = toFiniteNumber(attributes.outputTokens);
      const latencyMs = toFiniteNumber(attributes.latencyMs);
      const parsedTokensPerSecond = toFiniteNumber(attributes.tokps);
      const tokensPerSecond =
        parsedTokensPerSecond ??
        (outputTokens !== null && outputTokens > 0 && latencyMs !== null && latencyMs > 0
          ? outputTokens / (latencyMs / 1000)
          : null);

      metrics = {
        cost: cost !== null && cost >= 0 ? cost : null,
        outputTokens:
          outputTokens !== null && outputTokens >= 0
            ? Math.round(outputTokens)
            : null,
        latencyMs:
          latencyMs !== null && latencyMs >= 0 ? Math.round(latencyMs) : null,
        tokensPerSecond,
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
