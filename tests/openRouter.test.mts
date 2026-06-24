import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
  DEFAULT_OPENROUTER_LEARN_MODEL,
  extractAffordableOpenRouterMaxTokens,
  getOpenRouterEvaluationModel,
  getOpenRouterEvaluationReasoning,
  getOpenRouterLearnModel,
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "../app/lib/openRouter.ts";
import {
  classifyLlmInteractionKind,
  listLlmTraceInteractions,
  recordFailedLlmTrace,
} from "../app/lib/llmTraceStore.ts";

test("openRouterChatCompletion sends user trace identifiers", async () => {
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
        question: "What should traces include?",
        traceId: "trace-789",
      },
      body: {
        model: "google/gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const requestBody = requestBodies[0];
  assert.ok(requestBody);
  assert.equal(requestBody.user, "user-123");
  assert.equal(requestBody.session_id, "user-123");

  const trace = requestBody.trace as Record<string, unknown> | undefined;
  assert.equal(trace?.trace_id, "trace-789");
  assert.equal(trace?.span_name, "test_operation");
  assert.equal(trace?.user_id, "user-123");
  assert.equal(trace?.question_preview, "What should traces include?");
});

test("openRouterChatCompletion preserves an explicit session id", async () => {
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
      },
      body: {
        model: "google/gemini-3.5-flash",
        session_id: "learn:user-123:course-456",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies[0]?.user, "user-123");
  assert.equal(requestBodies[0]?.session_id, "learn:user-123:course-456");
});

test("classifyLlmInteractionKind uses explicit non-answer trace kinds", () => {
  assert.equal(classifyLlmInteractionKind("evaluate_answer"), "Answer evaluation");
  assert.equal(classifyLlmInteractionKind("add_questions_gate"), "Quality gate");
  assert.equal(classifyLlmInteractionKind("refresh_knowledge_memory"), "Knowledge memory");
  assert.equal(classifyLlmInteractionKind("question_embedding"), "Embedding");
  assert.equal(classifyLlmInteractionKind("test_operation"), "Other");
});

test("extractAffordableOpenRouterMaxTokens reads OpenRouter credit errors", () => {
  assert.equal(
    extractAffordableOpenRouterMaxTokens({
      error: {
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 10000 tokens, but can only afford 7070.",
        metadata: {
          previous_errors: [
            {
              code: 402,
              message:
                "This request requires more credits, or fewer max_tokens. You requested up to 10000 tokens, but can only afford 7070.",
            },
          ],
        },
      },
    }),
    7070,
  );
});

test("extractAffordableOpenRouterMaxTokens ignores unrelated errors", () => {
  assert.equal(
    extractAffordableOpenRouterMaxTokens({
      error: {
        message: "Provider is temporarily unavailable.",
      },
    }),
    null,
  );
});

test("getOpenRouterEvaluationModel defaults to Mercury and allows env override", () => {
  const originalModel = process.env.LLM_EVALUATION_MODEL;

  try {
    delete process.env.LLM_EVALUATION_MODEL;
    assert.equal(
      getOpenRouterEvaluationModel(),
      DEFAULT_OPENROUTER_EVALUATION_MODEL,
    );

    process.env.LLM_EVALUATION_MODEL = "openai/gpt-4.1-nano";
    assert.equal(getOpenRouterEvaluationModel(), "openai/gpt-4.1-nano");
  } finally {
    if (originalModel === undefined) {
      delete process.env.LLM_EVALUATION_MODEL;
    } else {
      process.env.LLM_EVALUATION_MODEL = originalModel;
    }
  }
});

test("getOpenRouterLearnModel defaults to Gemini 2.5 Flash and ignores global chat model", () => {
  const originalChatModel = process.env.LLM_MODEL;
  const originalLearnModel = process.env.LLM_LEARN_MODEL;

  try {
    process.env.LLM_MODEL = "openai/gpt-5.5";
    delete process.env.LLM_LEARN_MODEL;

    assert.equal(getOpenRouterLearnModel(), DEFAULT_OPENROUTER_LEARN_MODEL);

    process.env.LLM_LEARN_MODEL = "google/gemini-3.1-flash-lite";
    assert.equal(getOpenRouterLearnModel(), "google/gemini-3.1-flash-lite");
  } finally {
    if (originalChatModel === undefined) {
      delete process.env.LLM_MODEL;
    } else {
      process.env.LLM_MODEL = originalChatModel;
    }

    if (originalLearnModel === undefined) {
      delete process.env.LLM_LEARN_MODEL;
    } else {
      process.env.LLM_LEARN_MODEL = originalLearnModel;
    }
  }
});

test("getOpenRouterEvaluationReasoning disables Mercury reasoning", () => {
  assert.deepEqual(getOpenRouterEvaluationReasoning("inception/mercury-2"), {
    effort: "none",
    exclude: true,
  });
  assert.equal(
    getOpenRouterEvaluationReasoning("google/gemini-3.5-flash"),
    undefined,
  );
});

test("openRouterEmbeddings sends user trace identifiers", async () => {
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
  assert.equal(requestBody.session_id, "user-abc");

  const trace = requestBody.trace as Record<string, unknown> | undefined;
  assert.equal(trace?.trace_id, "trace-ghi");
  assert.equal(trace?.span_name, "test_embedding");
  assert.equal(trace?.user_id, "user-abc");
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
        model: "google/gemini-3.5-flash",
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
          prompt_tokens_details: {
            cached_tokens: 8,
            cache_write_tokens: 2,
          },
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
        question: "What payload should be visible?",
        traceId,
      },
      body: {
        model: "google/gemini-3.5-flash",
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
  assert.equal(trace.calls[0]?.cachedPromptTokens, 8);
  assert.equal(trace.calls[0]?.uncachedPromptTokens, 4);
  assert.equal(trace.calls[0]?.cacheWriteTokens, 2);
  assert.equal(trace.calls[0]?.cacheHitPercent, (8 / 12) * 100);
  assert.match(trace.calls[0]?.requestPayload ?? "", /hello/);
  assert.match(trace.calls[0]?.responsePayload ?? "", /prompt_tokens/);
});

test("listLlmTraceInteractions falls back to local traces when db read is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  const traceId = `trace-local-fallback-${Date.now()}`;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"score\":10}" } }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
        },
      }),
      { status: 200 },
    );

  try {
    await openRouterChatCompletion({
      apiKey: "test-key",
      stream: false,
      trace: {
        operation: "evaluate_answer",
        question: "What should admin show if db tracing is unavailable?",
        traceId,
      },
      body: {
        model: "google/gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    process.env.DATABASE_URL = "not-a-valid-database-url";
    console.error = () => {};

    const trace = (await listLlmTraceInteractions()).find(
      (candidate) => candidate.id === traceId,
    );

    assert.ok(trace);
    assert.equal(trace.calls[0]?.inputTokens, 7);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test("recordFailedLlmTrace records an error trace for configuration failures", async () => {
  const traceId = `trace-missing-key-${Date.now()}`;

  await recordFailedLlmTrace({
    traceId,
    operation: "evaluate_answer",
    model: "google/gemini-3.5-flash",
    question: "What should admin show for missing LLM configuration?",
    requestBody: {
      question: "What should admin show for missing LLM configuration?",
      answer: "an error trace",
      configured: false,
    },
    error: new Error("OPENROUTER_API_KEY or LLM_API_KEY is not configured."),
  });

  const trace = (await listLlmTraceInteractions()).find(
    (candidate) => candidate.id === traceId,
  );

  assert.ok(trace);
  assert.equal(trace.status, "error");
  assert.equal(trace.calls[0]?.operation, "evaluate_answer");
  assert.match(trace.calls[0]?.responsePayload ?? "", /not configured/);
});

test("openRouterChatCompletion streams text chunks and reports activity", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  let activityCount = 0;
  const deltas: string[] = [];
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
              })}\r\n\r\n`,
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
              })}\r\n\r\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\r\n\r\n"));
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
      onTextDelta: (delta) => {
        deltas.push(delta);
      },
      onActivity: () => {
        activityCount += 1;
      },
      trace: {
        operation: "test_streaming",
      },
      body: {
        model: "google/gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(requestBodies[0]?.stream, true);
    assert.deepEqual(requestBodies[0]?.stream_options, { include_usage: true });
    assert.equal(body.choices?.[0]?.message?.content, "{\"score\":10}");
    assert.deepEqual(deltas, ["{\"score\"", ":10}"]);
    assert.equal(body.usage?.completion_tokens, 4);
    assert.ok(activityCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openRouterChatCompletion preserves streamed tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const streamedToolCallDeltas: unknown[] = [];

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_widget",
                          type: "function",
                          function: {
                            name: "render_question_widget",
                            arguments: "{\"type\":\"free_text\",",
                          },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments:
                              "\"id\":\"check\",\"question\":\"What is PPO?\"}",
                          },
                        },
                      ],
                    },
                  },
                ],
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

  try {
    const { body } = await openRouterChatCompletion({
      apiKey: "test-key",
      trace: {
        operation: "test_streaming_tools",
      },
      body: {
        model: "google/gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
      },
      onToolCallDelta(toolCalls) {
        streamedToolCallDeltas.push(toolCalls);
      },
    });

    assert.equal(streamedToolCallDeltas.length, 2);
    assert.deepEqual(body.choices?.[0]?.message?.tool_calls, [
      {
        id: "call_widget",
        type: "function",
        function: {
          name: "render_question_widget",
          arguments:
            "{\"type\":\"free_text\",\"id\":\"check\",\"question\":\"What is PPO?\"}",
        },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
