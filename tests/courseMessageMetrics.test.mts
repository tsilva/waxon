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
      completion_tokens: 500,
      total_tokens: 25_500,
      cost: 0.02,
    },
    10_000,
    100_000,
  );

  assert.ok(metrics);
  assert.equal(metrics.promptTokens, 25_000);
  assert.equal(metrics.outputTokens, 500);
  assert.equal(metrics.totalTokens, 25_500);
  assert.equal(metrics.contextWindowTokens, 100_000);
  assert.equal(metrics.contextPercent, 25);

  const content = appendCourseMessageMetrics("Tutor reply", metrics);
  const parsed = parseCourseMessageMetrics(content);

  assert.equal(parsed.content, "Tutor reply");
  assert.equal(parsed.metrics?.promptTokens, 25_000);
  assert.equal(parsed.metrics?.totalTokens, 25_500);
  assert.equal(parsed.metrics?.contextWindowTokens, 100_000);
  assert.equal(parsed.metrics?.contextPercent, 25);
});
