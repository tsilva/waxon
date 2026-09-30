import assert from "node:assert/strict";
import test from "node:test";
import { ExpiringCache } from "../app/lib/expiringCache.ts";
import { EvaluationFailure, evaluateRecallWithRetries } from "../app/lib/v2/recallEvaluation.ts";

test("profile cache deduplicates reads and invalidation prevents an old result replacing fresh data", async () => {
  const cache = new ExpiringCache<string, string>(60_000, 2);
  let resolve!: (value: string) => void;
  let calls = 0;
  const load = () => { calls++; return new Promise<string>((done) => { resolve = done; }); };
  const first = cache.get("learner", load);
  const second = cache.get("learner", load);
  assert.equal(calls, 1);
  cache.delete("learner");
  assert.equal(await cache.get("learner", async () => "fresh"), "fresh");
  resolve("stale");
  assert.deepEqual(await Promise.all([first, second]), ["stale", "stale"]);
  assert.equal(await cache.get("learner", async () => "unexpected"), "fresh");
  await cache.get("other", async () => "other");
  await cache.get("third", async () => "third");
  assert.equal(await cache.get("learner", async () => "reloaded"), "reloaded");
});

test("expired profiles refresh instead of retaining obsolete identity fields", async () => {
  const cache = new ExpiringCache<string, string>(0, 2);
  assert.equal(await cache.get("learner", async () => "old"), "old");
  assert.equal(await cache.get("learner", async () => "new"), "new");
});

test("permanent evaluation errors do not consume repeated model attempts", async () => {
  let calls = 0;
  await assert.rejects(evaluateRecallWithRetries({ prompt: "Prompt", evaluate: async () => {
    calls++; throw new EvaluationFailure("Invalid provider configuration", false);
  }}), /Invalid provider configuration/u);
  assert.equal(calls, 1);
});

test("the total evaluation deadline aborts a hung provider without fabricating a grade", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  await assert.rejects(evaluateRecallWithRetries({ prompt: "Prompt", deadlineMs: 10,
    evaluate: async (received) => { calls++; signal = received; return new Promise(() => {}); },
  }), /total time limit/u);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("exhausted transport attempts cannot multiply through the job retry layer", async () => {
  let calls = 0;
  await assert.rejects(evaluateRecallWithRetries({ prompt: "Prompt", evaluate: async () => {
    calls++; throw new Error("Temporary network failure");
  }}), (error: unknown) => error instanceof EvaluationFailure && !error.retryable && error.message === "Temporary network failure");
  assert.equal(calls, 3);
});
