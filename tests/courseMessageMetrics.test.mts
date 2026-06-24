import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCourseMessageMetrics,
  metricsFromOpenRouterUsage,
  parseCourseMessageMetrics,
} from "../app/lib/courseMessageMetrics.ts";

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

  const content = appendCourseMessageMetrics("Tutor reply", metrics);
  const parsed = parseCourseMessageMetrics(content);

  assert.equal(parsed.content, "Tutor reply");
  assert.equal(parsed.metrics?.promptTokens, 25_000);
  assert.equal(parsed.metrics?.cachedPromptTokens, 15_000);
  assert.equal(parsed.metrics?.uncachedPromptTokens, 10_000);
  assert.equal(parsed.metrics?.cacheWriteTokens, 2_500);
  assert.equal(parsed.metrics?.cacheHitPercent, 60);
  assert.equal(parsed.metrics?.totalTokens, 25_500);
  assert.equal(parsed.metrics?.contextWindowTokens, 100_000);
  assert.equal(parsed.metrics?.contextPercent, 25);
});

test("course message metrics parse existing comments without cache fields", () => {
  const parsed = parseCourseMessageMetrics(
    "Tutor reply\n\n<!-- waxon:llm-metrics promptTokens=1000 outputTokens=100 totalTokens=1100 latencyMs=1000 tokps=100.00 -->",
  );

  assert.equal(parsed.content, "Tutor reply");
  assert.equal(parsed.metrics?.promptTokens, 1000);
  assert.equal(parsed.metrics?.cachedPromptTokens, null);
  assert.equal(parsed.metrics?.uncachedPromptTokens, null);
  assert.equal(parsed.metrics?.cacheWriteTokens, null);
  assert.equal(parsed.metrics?.cacheHitPercent, null);
});
