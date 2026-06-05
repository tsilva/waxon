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

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    signal: input.signal,
    headers: withOpenRouterHeaders(input.apiKey),
    body: JSON.stringify(body),
  });
  const parsed = (await parseOpenRouterJson(response)) as OpenRouterChatResponse;

  return { response, body: parsed };
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

  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    signal: input.signal,
    headers: withOpenRouterHeaders(input.apiKey),
    body: JSON.stringify(body),
  });
  const parsed = (await parseOpenRouterJson(response)) as OpenRouterEmbeddingResponse;

  return { response, body: parsed };
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
