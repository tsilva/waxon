import assert from "node:assert/strict";
import test from "node:test";
import {
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "../app/lib/openRouter.ts";

test("openRouterChatCompletion sends user and deck trace identifiers", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };

  try {
    await openRouterChatCompletion({
      apiKey: "test-key",
      trace: {
        operation: "test_operation",
        userId: "user-123",
        deckId: "deck-456",
        question: "What should traces include?",
        traceId: "trace-789",
      },
      body: {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const requestBody = requestBodies[0];
  assert.ok(requestBody);
  assert.equal(requestBody.user, "user-123");
  assert.equal(requestBody.session_id, "deck-456");

  const trace = requestBody.trace as Record<string, unknown> | undefined;
  assert.equal(trace?.trace_id, "trace-789");
  assert.equal(trace?.span_name, "test_operation");
  assert.equal(trace?.user_id, "user-123");
  assert.equal(trace?.deck_id, "deck-456");
  assert.equal(trace?.question_preview, "What should traces include?");
});

test("openRouterEmbeddings sends user and deck trace identifiers", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  try {
    await openRouterEmbeddings({
      apiKey: "test-key",
      trace: {
        operation: "test_embedding",
        userId: "user-abc",
        deckId: "deck-def",
        traceId: "trace-ghi",
      },
      body: {
        model: "test-embedding-model",
        input: ["hello"],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const requestBody = requestBodies[0];
  assert.ok(requestBody);
  assert.equal(requestBody.user, "user-abc");
  assert.equal(requestBody.session_id, "deck-def");

  const trace = requestBody.trace as Record<string, unknown> | undefined;
  assert.equal(trace?.trace_id, "trace-ghi");
  assert.equal(trace?.span_name, "test_embedding");
  assert.equal(trace?.user_id, "user-abc");
  assert.equal(trace?.deck_id, "deck-def");
});

test("openRouterChatCompletion mirrors body user into trace metadata", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };

  try {
    await openRouterChatCompletion({
      apiKey: "test-key",
      trace: {
        operation: "test_operation",
      },
      body: {
        model: "test-model",
        user: "body-user",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const requestBody = requestBodies[0];
  assert.ok(requestBody);

  const trace = requestBody.trace as Record<string, unknown> | undefined;
  assert.equal(requestBody.user, "body-user");
  assert.equal(trace?.user_id, "body-user");
});
