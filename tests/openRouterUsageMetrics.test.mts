import assert from "node:assert/strict";
import test from "node:test";
import { promptCacheMetricsFromOpenRouterUsage } from "../app/lib/openRouterUsageMetrics.ts";

test("OpenRouter usage metrics normalize prompt-cache data", () => {
  const metrics = promptCacheMetricsFromOpenRouterUsage({
    prompt_tokens: 25_000,
    prompt_tokens_details: {
      cached_tokens: 15_000,
    },
    cache_write_tokens: 2_500,
  });

  assert.equal(metrics.promptTokens, 25_000);
  assert.equal(metrics.cachedPromptTokens, 15_000);
  assert.equal(metrics.uncachedPromptTokens, 10_000);
  assert.equal(metrics.cacheWriteTokens, 2_500);
  assert.equal(metrics.cacheHitPercent, 60);
});
