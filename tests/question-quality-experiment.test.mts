import assert from "node:assert/strict";
import test from "node:test";
import { answerQuestion, answerRequest, flagDetail, runConcurrent, runQuestion, type ExperimentQuestion } from "../shared/question-quality-experiment.mts";

const question: ExperimentQuestion = { id: "q1", userId: "owner", prompt: "What is two plus two?", referenceAnswer: "SECRET: four", lifecycle: "active" };
test("answer request exposes only one prompt and evaluator receives the standard separately", async () => {
  const body = answerRequest(question.prompt);
  assert.equal(body.messages.length, 1);
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.provider.require_parameters, true);
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
  const result = await runQuestion(question, async (prompt) => {
    assert.equal(prompt, question.prompt);
    return "four";
  }, async (input) => {
    assert.equal(input.referenceAnswer, question.referenceAnswer);
    assert.equal(input.answer, "four");
    assert.equal(input.browserAcceptanceEvaluationAuthorized, undefined);
    return { recallResult: "correct", coveredPoints: ["four"], scoringIssues: [], confidence: 1, feedback: "Correct" };
  });
  assert.equal(result.evaluation?.recallResult, "correct");
  assert.equal(flagDetail(result, "run"), null);
});
test("transport failures never become quality flags", async () => {
  const result = await runQuestion(question, async () => { throw new Error("timeout"); }, async () => { throw new Error("must not evaluate"); });
  assert.equal(result.error, "timeout");
  assert.equal(flagDetail(result, "run"), null);
});
test("workers are bounded and process each question once", async () => {
  let active = 0;
  let maximum = 0;
  const visited: number[] = [];
  await runConcurrent([1, 2, 3, 4, 5], 2, async (item) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    visited.push(item);
    active--;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(visited.sort(), [1, 2, 3, 4, 5]);
});
test("non-correct feedback is framed as suspected quality and fits the flag limit", () => {
  const detail = flagDetail({ question, answer: "x".repeat(5000), elapsedMs: 1, evaluation: {
    recallResult: "partial", coveredPoints: ["addition"], scoringIssues: ["wrong total"], confidence: 1, feedback: "Wrong total",
  } }, "run")!;
  assert.ok(detail.includes("suspected") || detail.includes("Suspected"));
  assert.ok(detail.includes("wrong total"));
  assert.ok(detail.length <= 4000);
});

test("live transport rejects truncated output and substituted models before evaluation", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-only-key";
  try {
    for (const [model, finishReason, message] of [
      ["deepseek/deepseek-v4.1-flash", "length", /incomplete/],
      ["other-model", "stop", /identity mismatch/],
    ] as const) {
      globalThis.fetch = async (_url, options) => {
        assert.deepEqual(JSON.parse(String(options?.body)), answerRequest(question.prompt));
        return new Response(JSON.stringify({ model, choices: [{ finish_reason: finishReason, message: { content: "four" } }] }), { status: 200 });
      };
      await assert.rejects(answerQuestion(question.prompt), message);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("dispatch stops after a failure signal while retaining completed work", async () => {
  const visited: number[] = [];
  await runConcurrent([1, 2, 3, 4], 1, async (item) => {
    visited.push(item);
    return item < 2;
  });
  assert.deepEqual(visited, [1, 2]);
});
test("body-read failures are retried, not just failures before headers", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-only-key";
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("body timeout")); } }));
      return new Response(JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", choices: [{ finish_reason: "stop", message: { content: "four" } }] }));
    };
    assert.equal(await answerQuestion(question.prompt), "four");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
