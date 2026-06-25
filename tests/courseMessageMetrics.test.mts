import assert from "node:assert/strict";
import test from "node:test";
import { metricsFromOpenRouterUsage } from "../app/lib/courseMessageMetrics.ts";

test("course message metrics track context fullness", () => {
  const metrics = metricsFromOpenRouterUsage(
    {
      prompt_tokens: 25_000,
      prompt_tokens_details: {
        cached_tokens: 15_000,
      },
      completion_tokens: 500,
      total_tokens: 25_500,
      cache_write_tokens: 2_500,
      cost: 0.02,
    },
    10_000,
    100_000,
  );

  assert.ok(metrics);
  assert.equal(metrics.promptTokens, 25_000);
  assert.equal(metrics.cachedPromptTokens, 15_000);
  assert.equal(metrics.uncachedPromptTokens, 10_000);
  assert.equal(metrics.cacheWriteTokens, 2_500);
  assert.equal(metrics.cacheHitPercent, 60);
  assert.equal(metrics.outputTokens, 500);
  assert.equal(metrics.totalTokens, 25_500);
  assert.equal(metrics.contextWindowTokens, 100_000);
  assert.equal(metrics.contextPercent, 25);

});
