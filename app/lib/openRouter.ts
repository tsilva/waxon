import {
  beginLlmTrace,
  finishLlmTrace,
} from "./llmTraceStore.ts";

export type OpenRouterTraceContext = {
  operation: string;
  userId?: string | null;
  question?: string | null;
  traceId?: string | null;
};

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type OpenRouterToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type OpenRouterChatRequest = {
  model: string;
  messages: OpenRouterMessage[];
  session_id?: string;
  response_format?: unknown;
  reasoning?: unknown;
  reasoning_effort?: string;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  stream?: boolean;
  stream_options?: unknown;
  cache_control?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
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
  prompt_tokens_details?: unknown;
  cache_read_tokens?: unknown;
  cached_tokens?: unknown;
  cache_write_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
};

export type OpenRouterChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: OpenRouterToolCall[] };
    message?: { content?: unknown; tool_calls?: OpenRouterToolCall[] };
  }>;
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
const AFFORDABLE_MAX_TOKENS_PATTERN = /can only afford\s+(\d+)/iu;
export const DEFAULT_OPENROUTER_CHAT_MODEL = "google/gemini-3.1-flash-lite";
export const DEFAULT_OPENROUTER_LEARN_MODEL = "google/gemini-3.1-flash-lite";
export const DEFAULT_OPENROUTER_EVALUATION_MODEL =
  "google/gemini-3.1-flash-lite";

type OpenRouterChatConfig =
  | {
      ok: true;
      apiKey: string;
      model: string;
    }
  | {
      ok: false;
      error: string;
    };

export function getOpenRouterApiKey(): string | null {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY ?? "";

  return apiKey.trim() || null;
}

export function getOpenRouterChatModel(input: {
  requireConfiguredModel?: boolean;
} = {}): string | null {
  const model = process.env.LLM_MODEL?.trim() ?? "";

  if (model) {
    return model;
  }

  return input.requireConfiguredModel ? null : DEFAULT_OPENROUTER_CHAT_MODEL;
}

export function getOpenRouterLearnModel(input: {
  requireConfiguredModel?: boolean;
} = {}): string | null {
  const model = process.env.LLM_LEARN_MODEL?.trim() ?? "";

  if (model) {
    return model;
  }

  return input.requireConfiguredModel ? null : DEFAULT_OPENROUTER_LEARN_MODEL;
}

export function getOpenRouterEvaluationModel(input: {
  requireConfiguredModel?: boolean;
} = {}): string | null {
  const model = process.env.LLM_EVALUATION_MODEL?.trim() ?? "";

  if (model) {
    return model;
  }

  if (input.requireConfiguredModel) {
    return null;
  }

  return DEFAULT_OPENROUTER_EVALUATION_MODEL;
}

export function getOpenRouterEvaluationReasoning(
  model: string,
): unknown | undefined {
  if (model.trim().toLowerCase() === "inception/mercury-2") {
    return {
      effort: "none",
      exclude: true,
    };
  }

  return undefined;
}

export function getOpenRouterChatConfig(input: {
  requireConfiguredModel?: boolean;
} = {}): OpenRouterChatConfig {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return {
      ok: false,
      error: "OPENROUTER_API_KEY or LLM_API_KEY is not configured.",
    };
  }

  const model = getOpenRouterChatModel({
    requireConfiguredModel: input.requireConfiguredModel,
  });

  if (!model) {
    return {
      ok: false,
      error: "LLM_MODEL is not configured.",
    };
  }

  return { ok: true, apiKey, model };
}

export function getOpenRouterLearnConfig(input: {
  requireConfiguredModel?: boolean;
} = {}): OpenRouterChatConfig {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return {
      ok: false,
      error: "OPENROUTER_API_KEY or LLM_API_KEY is not configured.",
    };
  }

  const model = getOpenRouterLearnModel({
    requireConfiguredModel: input.requireConfiguredModel,
  });

  if (!model) {
    return {
      ok: false,
      error: "LLM_LEARN_MODEL is not configured.",
    };
  }

  return { ok: true, apiKey, model };
}

export function getOpenRouterEvaluationConfig(input: {
  requireConfiguredModel?: boolean;
} = {}): OpenRouterChatConfig {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return {
      ok: false,
      error: "OPENROUTER_API_KEY or LLM_API_KEY is not configured.",
    };
  }

  const model = getOpenRouterEvaluationModel({
    requireConfiguredModel: input.requireConfiguredModel,
  });

  if (!model) {
    return {
      ok: false,
      error: "LLM_EVALUATION_MODEL is not configured.",
    };
  }

  return { ok: true, apiKey, model };
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

export function extractAffordableOpenRouterMaxTokens(
  responseBody: unknown,
): number | null {
  const messages: string[] = [];
  const collectMessages = (value: unknown) => {
    if (typeof value === "string") {
      messages.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectMessages(item);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    for (const nestedValue of Object.values(value)) {
      collectMessages(nestedValue);
    }
  };

  collectMessages(responseBody);

  const tokenLimits = messages
    .map((message) => AFFORDABLE_MAX_TOKENS_PATTERN.exec(message)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  return tokenLimits.length > 0 ? Math.min(...tokenLimits) : null;
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

function extractStreamingToolCallDeltas(chunk: unknown): OpenRouterToolCall[] {
  const body = chunk as {
    choices?: Array<{
      delta?: {
        tool_calls?: unknown;
      };
      message?: {
        tool_calls?: unknown;
      };
    }>;
  };
  const toolCalls =
    body.choices?.[0]?.delta?.tool_calls ?? body.choices?.[0]?.message?.tool_calls;

  return Array.isArray(toolCalls) ? (toolCalls as OpenRouterToolCall[]) : [];
}

function mergeStreamingToolCallDeltas(
  toolCalls: Array<OpenRouterToolCall & { index?: number }>,
  deltas: OpenRouterToolCall[],
) {
  for (const [fallbackIndex, delta] of deltas.entries()) {
    const deltaWithIndex = delta as OpenRouterToolCall & { index?: unknown };
    const index =
      typeof deltaWithIndex.index === "number" &&
      Number.isFinite(deltaWithIndex.index) &&
      deltaWithIndex.index >= 0
        ? Math.round(deltaWithIndex.index)
        : fallbackIndex;
    const existing =
      toolCalls[index] ??
      ({
        function: {
          arguments: "",
        },
      } as OpenRouterToolCall & { index?: number });

    existing.index = index;
    existing.id = delta.id ?? existing.id;
    existing.type = delta.type ?? existing.type;

    if (delta.function) {
      existing.function = {
        name: delta.function.name ?? existing.function?.name,
        arguments:
          (existing.function?.arguments ?? "") +
          (typeof delta.function.arguments === "string"
            ? delta.function.arguments
            : ""),
      };
    }

    toolCalls[index] = existing;
  }
}

function finalizeStreamingToolCalls(
  toolCalls: Array<OpenRouterToolCall & { index?: number }>,
): OpenRouterToolCall[] {
  return toolCalls.flatMap((toolCall) => {
    if (!toolCall.function?.name) {
      return [];
    }

    return [
      {
        id: toolCall.id,
        type: toolCall.type ?? "function",
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments ?? "",
        },
      },
    ];
  });
}

function findStreamingEventBoundary(buffer: string):
  | {
      index: number;
      length: number;
    }
  | null {
  const lfBoundary = buffer.indexOf("\n\n");
  const crlfBoundary = buffer.indexOf("\r\n\r\n");

  if (lfBoundary === -1 && crlfBoundary === -1) {
    return null;
  }

  if (lfBoundary !== -1 && (crlfBoundary === -1 || lfBoundary < crlfBoundary)) {
    return { index: lfBoundary, length: 2 };
  }

  return { index: crlfBoundary, length: 4 };
}

async function parseOpenRouterStream(
  response: Response,
  onActivity?: () => void,
  onTextDelta?: (delta: string) => void,
  onToolCallDelta?: (toolCalls: OpenRouterToolCall[]) => void,
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
  const streamedToolCalls: Array<OpenRouterToolCall & { index?: number }> = [];

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
      const toolCallDeltas = extractStreamingToolCallDeltas(parsed);
      mergeStreamingToolCallDeltas(streamedToolCalls, toolCallDeltas);

      if (toolCallDeltas.length > 0) {
        onToolCallDelta?.(toolCallDeltas);
        onActivity?.();
      }

      const deltaText = extractStreamingDeltaText(parsed);

      if (deltaText) {
        content += deltaText;
        onTextDelta?.(deltaText);
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

    let eventBoundary = findStreamingEventBoundary(buffer);

    while (eventBoundary) {
      const eventText = buffer.slice(0, eventBoundary.index);
      buffer = buffer.slice(eventBoundary.index + eventBoundary.length);
      parseEvent(eventText);
      eventBoundary = findStreamingEventBoundary(buffer);
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

  const toolCalls = finalizeStreamingToolCalls(streamedToolCalls);

  return {
    id: finalResponseChunk?.id,
    model: finalResponseChunk?.model,
    choices: [
      {
        message: {
          content,
          tool_calls:
            toolCalls.length > 0
              ? toolCalls
              : finalResponseChunk?.choices?.[0]?.message?.tool_calls,
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
  onTextDelta?: (delta: string) => void;
  onToolCallDelta?: (toolCalls: OpenRouterToolCall[]) => void;
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
    session_id: input.body.session_id ?? trace.userId ?? undefined,
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
        ? await parseOpenRouterStream(
            response,
            input.onActivity,
            input.onTextDelta,
            input.onToolCallDelta,
          )
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
    session_id: trace.userId ?? undefined,
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

  if (trace.question) {
    metadata.question_preview = trace.question.slice(0, 160);
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
