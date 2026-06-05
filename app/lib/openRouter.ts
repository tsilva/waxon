import {
  beginLlmTrace,
  finishLlmTrace,
} from "./llmTraceStore.ts";

export type OpenRouterTraceContext = {
  operation: string;
  userId?: string | null;
  deckId?: string | null;
  question?: string | null;
  traceId?: string | null;
};

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

export type OpenRouterChatRequest = {
  model: string;
  messages: OpenRouterMessage[];
  response_format?: unknown;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  stream?: boolean;
  stream_options?: unknown;
};

export type OpenRouterEmbeddingRequest = {
  model: string;
  input: string[];
  encoding_format?: "float";
  user?: string;
};

type OpenRouterUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cost?: unknown;
};

export type OpenRouterChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: OpenRouterUsage & Record<string, unknown>;
};

export type OpenRouterEmbeddingResponse = {
  id?: string;
  model?: string;
  data?: Array<{ embedding?: unknown }>;
  usage?: OpenRouterUsage & Record<string, unknown>;
};

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const STREAM_DONE_SENTINEL = "[DONE]";

export function getOpenRouterApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? null;
}

export function extractChatCompletionText(response: unknown): string {
  const body = response as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const candidate = part as { text?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function withOpenRouterHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_TITLE ?? "waxon",
  };
}

async function parseOpenRouterJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 1_000) };
  }
}

function extractStreamingDeltaText(chunk: unknown): string {
  const body = chunk as {
    choices?: Array<{
      delta?: {
        content?: unknown;
      };
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content =
    body.choices?.[0]?.delta?.content ?? body.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const candidate = part as { text?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("");
  }

  return "";
}

async function parseOpenRouterStream(
  response: Response,
  onActivity?: () => void,
): Promise<OpenRouterChatResponse> {
  if (!response.body) {
    return (await parseOpenRouterJson(response)) as OpenRouterChatResponse;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";
  let content = "";
  let finalChunk: OpenRouterChatResponse | null = null;
  let usage: OpenRouterUsage | undefined;

  const parseEvent = (eventText: string) => {
    const payloads = eventText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    for (const payload of payloads) {
      if (payload === STREAM_DONE_SENTINEL) {
        continue;
      }

      let parsed: OpenRouterChatResponse;

      try {
        parsed = JSON.parse(payload) as OpenRouterChatResponse;
      } catch {
        continue;
      }

      finalChunk = parsed;
      usage = parsed.usage ?? usage;

      const deltaText = extractStreamingDeltaText(parsed);

      if (deltaText) {
        content += deltaText;
        onActivity?.();
      }
    }
  };

  onActivity?.();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    onActivity?.();
    const text = decoder.decode(value, { stream: true });
    rawText += text;
    buffer += text;

    let eventBoundary = buffer.indexOf("\n\n");

    while (eventBoundary !== -1) {
      const eventText = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);
      parseEvent(eventText);
      eventBoundary = buffer.indexOf("\n\n");
    }
  }

  const finalText = decoder.decode();
  rawText += finalText;
  buffer += finalText;

  if (buffer.trim()) {
    parseEvent(buffer);
  }

  const finalResponseChunk = finalChunk as OpenRouterChatResponse | null;

  if (!finalResponseChunk && rawText.trim()) {
    try {
      return JSON.parse(rawText) as OpenRouterChatResponse;
    } catch {
      return {
        choices: [
          {
            message: {
              content: rawText.trim(),
            },
          },
        ],
      };
    }
  }

  return {
    id: finalResponseChunk?.id,
    model: finalResponseChunk?.model,
    choices: [
      {
        message: {
          content,
        },
      },
    ],
    usage,
  };
}

export async function openRouterChatCompletion(input: {
  apiKey: string;
  body: OpenRouterChatRequest;
  signal?: AbortSignal;
  trace: OpenRouterTraceContext;
  stream?: boolean;
  onActivity?: () => void;
}): Promise<{ response: Response; body: OpenRouterChatResponse }> {
  const traceId = input.trace.traceId ?? crypto.randomUUID();
  const trace = {
    ...input.trace,
    userId: input.trace.userId ?? input.body.user ?? null,
  };
  const shouldStream = input.stream ?? true;
  const body = {
    ...input.body,
    stream: input.body.stream ?? shouldStream,
    stream_options:
      input.body.stream_options ??
      (shouldStream ? { include_usage: true } : undefined),
    user: input.body.user ?? trace.userId ?? undefined,
    session_id: trace.deckId ?? undefined,
    trace: buildTraceMetadata(trace, traceId),
  };
  const pendingTrace = beginLlmTrace({
    traceId,
    operation: trace.operation,
    model: body.model,
    question: trace.question,
    requestBody: body,
  });

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: input.signal,
      headers: withOpenRouterHeaders(input.apiKey),
      body: JSON.stringify(body),
    });
    const parsed =
      body.stream && response.ok
        ? await parseOpenRouterStream(response, input.onActivity)
        : ((await parseOpenRouterJson(response)) as OpenRouterChatResponse);

    await finishLlmTrace(pendingTrace, {
      ok: response.ok,
      responseBody: {
        status: response.status,
        statusText: response.statusText,
        body: parsed,
      },
      usage: parsed.usage,
    });

    return { response, body: parsed };
  } catch (error) {
    await finishLlmTrace(pendingTrace, {
      ok: false,
      error,
    });
    throw error;
  }
}

export async function openRouterEmbeddings(input: {
  apiKey: string;
  body: OpenRouterEmbeddingRequest;
  signal?: AbortSignal;
  trace: OpenRouterTraceContext;
}): Promise<{ response: Response; body: OpenRouterEmbeddingResponse }> {
  const traceId = input.trace.traceId ?? crypto.randomUUID();
  const trace = {
    ...input.trace,
    userId: input.trace.userId ?? input.body.user ?? null,
  };
  const body = {
    ...input.body,
    user: input.body.user ?? trace.userId ?? undefined,
    session_id: trace.deckId ?? undefined,
    trace: buildTraceMetadata(trace, traceId),
  };
  const pendingTrace = beginLlmTrace({
    traceId,
    operation: trace.operation,
    model: body.model,
    question: trace.question,
    requestBody: body,
  });

  try {
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      signal: input.signal,
      headers: withOpenRouterHeaders(input.apiKey),
      body: JSON.stringify(body),
    });
    const parsed = (await parseOpenRouterJson(
      response,
    )) as OpenRouterEmbeddingResponse;

    await finishLlmTrace(pendingTrace, {
      ok: response.ok,
      responseBody: {
        status: response.status,
        statusText: response.statusText,
        body: parsed,
      },
      usage: parsed.usage,
    });

    return { response, body: parsed };
  } catch (error) {
    await finishLlmTrace(pendingTrace, {
      ok: false,
      error,
    });
    throw error;
  }
}

function buildTraceMetadata(
  trace: OpenRouterTraceContext,
  traceId: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    trace_id: traceId,
    trace_name: "waxon",
    span_name: trace.operation,
    generation_name: trace.operation,
    environment:
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      undefined,
    operation: trace.operation,
  };

  if (trace.userId) {
    metadata.user_id = trace.userId;
  }

  if (trace.deckId) {
    metadata.deck_id = trace.deckId;
  }

  if (trace.question) {
    metadata.question_preview = trace.question.slice(0, 160);
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
