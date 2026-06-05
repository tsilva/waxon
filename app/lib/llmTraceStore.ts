export type LlmTraceCallType =
  | "answer_eval"
  | "question_generation"
  | "embedding"
  | "summarization";

export type LlmTraceStatus = "ok" | "pending" | "error";

export type LlmTraceCall = {
  id: string;
  operation: string;
  model: string;
  callType: LlmTraceCallType;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  status: LlmTraceStatus;
  startedAt: string;
  requestPayload?: string;
  responsePayload?: string;
};

export type LlmTraceInteraction = {
  id: string;
  title: string;
  kind: "Answer submitted" | "Question generation" | "Reference answer";
  startedAt: string;
  status: LlmTraceStatus;
  calls: LlmTraceCall[];
};

type PendingTrace = {
  traceId: string;
  callId: string;
  operation: string;
  model: string;
  callType: LlmTraceCallType;
  title: string;
  kind: LlmTraceInteraction["kind"];
  startedAt: number;
  requestPayload: string;
};

type LlmTraceState = {
  interactions: LlmTraceInteraction[];
};

const MAX_TRACE_INTERACTIONS = 200;

const globalForTraceStore = globalThis as typeof globalThis & {
  waxonLlmTraces?: LlmTraceState;
};

const state: LlmTraceState =
  globalForTraceStore.waxonLlmTraces ?? {
    interactions: [],
  };

globalForTraceStore.waxonLlmTraces = state;

export function classifyLlmCallType(operation: string): LlmTraceCallType {
  if (operation.includes("embedding")) {
    return "embedding";
  }

  if (operation.includes("generate") || operation.includes("dedupe")) {
    return "question_generation";
  }

  if (operation.includes("reference") || operation.includes("summary")) {
    return "summarization";
  }

  return "answer_eval";
}

export function classifyLlmInteractionKind(
  operation: string,
): LlmTraceInteraction["kind"] {
  if (operation.includes("generate") || operation.includes("dedupe")) {
    return "Question generation";
  }

  if (operation.includes("reference")) {
    return "Reference answer";
  }

  return "Answer submitted";
}

export function beginLlmTrace(input: {
  traceId: string;
  operation: string;
  model: string;
  question?: string | null;
  requestBody: unknown;
}): PendingTrace {
  const startedAt = Date.now();
  const titleSubject = input.question?.trim()
    ? input.question.trim().slice(0, 90)
    : input.operation;
  const kind = classifyLlmInteractionKind(input.operation);
  const pending: PendingTrace = {
    traceId: input.traceId,
    callId: input.traceId,
    operation: input.operation,
    model: input.model,
    callType: classifyLlmCallType(input.operation),
    title:
      kind === "Answer submitted"
        ? `Answer submitted: ${titleSubject}`
        : `${kind}: ${titleSubject}`,
    kind,
    startedAt,
    requestPayload: JSON.stringify(input.requestBody, null, 2),
  };

  const interaction: LlmTraceInteraction = {
    id: pending.traceId,
    title: pending.title,
    kind: pending.kind,
    startedAt: new Date(startedAt).toISOString(),
    status: "pending",
    calls: [
      {
        id: pending.callId,
        operation: pending.operation,
        model: pending.model,
        callType: pending.callType,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        latencyMs: 0,
        status: "pending",
        startedAt: new Date(startedAt).toISOString(),
        requestPayload: pending.requestPayload,
      },
    ],
  };

  state.interactions = [
    interaction,
    ...state.interactions.filter((trace) => trace.id !== pending.traceId),
  ].slice(0, MAX_TRACE_INTERACTIONS);

  return pending;
}

export function finishLlmTrace(
  pending: PendingTrace,
  input: {
    ok: boolean;
    responseBody?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      cost?: unknown;
    };
    error?: unknown;
  },
): void {
  const interaction = state.interactions.find(
    (candidate) => candidate.id === pending.traceId,
  );
  const call = interaction?.calls.find(
    (candidate) => candidate.id === pending.callId,
  );

  if (!interaction || !call) {
    return;
  }

  const inputTokens = toFiniteNumber(input.usage?.prompt_tokens);
  const outputTokens = toFiniteNumber(input.usage?.completion_tokens);
  const totalTokens = toFiniteNumber(input.usage?.total_tokens);

  call.status = input.ok && !input.error ? "ok" : "error";
  call.latencyMs = Date.now() - pending.startedAt;
  call.inputTokens =
    inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0));
  call.outputTokens = outputTokens ?? 0;
  call.cost = toFiniteNumber(input.usage?.cost) ?? 0;
  call.responsePayload = JSON.stringify(
    input.error
      ? {
          error:
            input.error instanceof Error
              ? input.error.message
              : "unknown error",
        }
      : (input.responseBody ?? {}),
    null,
    2,
  );

  interaction.status = call.status;
}

export function listLlmTraceInteractions(): LlmTraceInteraction[] {
  return state.interactions.map((interaction) => ({
    ...interaction,
    calls: interaction.calls.map((call) => ({ ...call })),
  }));
}

function toFiniteNumber(value: unknown): number | null {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(numberValue) ? numberValue : null;
}
