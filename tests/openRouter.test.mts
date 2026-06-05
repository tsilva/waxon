import assert from "node:assert/strict";
import test from "node:test";
import {
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "../app/lib/openRouter.ts";
import { listLlmTraceInteractions } from "../app/lib/llmTraceStore.ts";

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
      stream: false,
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
      stream: false,
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

test("openRouterChatCompletion records actual request and response payloads", async () => {
  const originalFetch = globalThis.fetch;
  const traceId = `trace-recording-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"score\":10}" } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          cost: 0.001,
        },
      }),
      { status: 200, statusText: "OK" },
    );

  try {
    await openRouterChatCompletion({
      apiKey: "test-key",
      stream: false,
      trace: {
        operation: "evaluate_answer",
        userId: "user-recording",
        deckId: "deck-recording",
        question: "What payload should be visible?",
        traceId,
      },
      body: {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const trace = (await listLlmTraceInteractions()).find(
    (candidate) => candidate.id === traceId,
  );

  assert.ok(trace);
  assert.equal(trace.status, "ok");
  assert.equal(trace.calls[0]?.operation, "evaluate_answer");
  assert.equal(trace.calls[0]?.inputTokens, 12);
  assert.match(trace.calls[0]?.requestPayload ?? "", /hello/);
  assert.match(trace.calls[0]?.responsePayload ?? "", /prompt_tokens/);
});

test("openRouterChatCompletion streams text chunks and reports activity", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  let activityCount = 0;
  const encoder = new TextEncoder();

  globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: "{\"score\"" } }],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: ":10}" } }],
                usage: {
                  prompt_tokens: 8,
                  completion_tokens: 4,
                  total_tokens: 12,
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      },
    );
  };

  try {
    const { body } = await openRouterChatCompletion({
      apiKey: "test-key",
      onActivity: () => {
        activityCount += 1;
      },
      trace: {
        operation: "test_streaming",
      },
      body: {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(requestBodies[0]?.stream, true);
    assert.deepEqual(requestBodies[0]?.stream_options, { include_usage: true });
    assert.equal(body.choices?.[0]?.message?.content, "{\"score\":10}");
    assert.equal(body.usage?.completion_tokens, 4);
    assert.ok(activityCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
