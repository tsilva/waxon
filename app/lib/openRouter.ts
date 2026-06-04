import { db } from "@/app/db/client";
import { llmCalls } from "@/app/db/schema";

export type OpenRouterTraceContext = {
  operation: string;
  userId?: string | null;
  deckId?: string | null;
  question?: string | null;
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

async function logOpenRouterCall(input: {
  context: OpenRouterTraceContext;
  requestModel: string;
  response?: OpenRouterChatResponse | OpenRouterEmbeddingResponse;
  status: "ok" | "error";
  httpStatus?: number;
  latencyMs: number;
  error?: string;
}): Promise<void> {
  const usage = input.response?.usage;

  try {
    await db.insert(llmCalls).values({
      operation: input.context.operation,
      provider: "openrouter",
      userId: input.context.userId ?? null,
      deckId: input.context.deckId ?? null,
      question: input.context.question ?? null,
      requestedModel: input.requestModel,
      returnedModel: input.response?.model ?? null,
      generationId: input.response?.id ?? null,
      status: input.status,
      httpStatus: input.httpStatus ?? null,
      promptTokens: toFiniteInteger(usage?.prompt_tokens),
      completionTokens: toFiniteInteger(usage?.completion_tokens),
      totalTokens: toFiniteInteger(usage?.total_tokens),
      cost: toFiniteNumber(usage?.cost),
      latencyMs: input.latencyMs,
      usage: usage ? (usage as Record<string, unknown>) : null,
      error: input.error?.slice(0, 1_000) ?? null,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.info("[waxon] llm call trace insert failed", {
      operation: input.context.operation,
      userId: input.context.userId,
      deckId: input.context.deckId,
      generationId: input.response?.id,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

function toFiniteInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);

  return Number.isFinite(number) ? Math.round(number) : null;
}

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);

  return Number.isFinite(number) ? number : null;
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

export async function openRouterChatCompletion(input: {
  apiKey: string;
  body: OpenRouterChatRequest;
  signal?: AbortSignal;
  trace: OpenRouterTraceContext;
}): Promise<{ response: Response; body: OpenRouterChatResponse }> {
  const startedAt = Date.now();
  const body = {
    ...input.body,
    user: input.body.user ?? input.trace.userId ?? undefined,
  };

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    signal: input.signal,
    headers: withOpenRouterHeaders(input.apiKey),
    body: JSON.stringify(body),
  });
  const parsed = (await parseOpenRouterJson(response)) as OpenRouterChatResponse;

  await logOpenRouterCall({
    context: input.trace,
    requestModel: input.body.model,
    response: parsed,
    status: response.ok ? "ok" : "error",
    httpStatus: response.status,
    latencyMs: Date.now() - startedAt,
    error: response.ok
      ? undefined
      : extractOpenRouterError(parsed) || response.statusText,
  });

  return { response, body: parsed };
}

export async function openRouterEmbeddings(input: {
  apiKey: string;
  body: OpenRouterEmbeddingRequest;
  signal?: AbortSignal;
  trace: OpenRouterTraceContext;
}): Promise<{ response: Response; body: OpenRouterEmbeddingResponse }> {
  const startedAt = Date.now();
  const body = {
    ...input.body,
    user: input.body.user ?? input.trace.userId ?? undefined,
  };

  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    signal: input.signal,
    headers: withOpenRouterHeaders(input.apiKey),
    body: JSON.stringify(body),
  });
  const parsed = (await parseOpenRouterJson(response)) as OpenRouterEmbeddingResponse;

  await logOpenRouterCall({
    context: input.trace,
    requestModel: input.body.model,
    response: parsed,
    status: response.ok ? "ok" : "error",
    httpStatus: response.status,
    latencyMs: Date.now() - startedAt,
    error: response.ok
      ? undefined
      : extractOpenRouterError(parsed) || response.statusText,
  });

  return { response, body: parsed };
}

function extractOpenRouterError(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const record = body as Record<string, unknown>;
  const error = record.error;

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : "";
  }

  return "";
}
