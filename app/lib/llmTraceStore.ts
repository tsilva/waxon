import { desc } from "drizzle-orm";
import type { llmTraceInteractions } from "../db/schema";

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
const MAX_PERSISTED_TRACE_PAYLOAD_CHARS = 12_000;

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

export async function finishLlmTrace(
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
): Promise<void> {
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

  void persistTraceInteraction(interaction);
}

export async function recordFailedLlmTrace(input: {
  traceId: string;
  operation: string;
  model: string;
  question?: string | null;
  requestBody: unknown;
  error: Error;
}): Promise<void> {
  const pendingTrace = beginLlmTrace({
    traceId: input.traceId,
    operation: input.operation,
    model: input.model,
    question: input.question,
    requestBody: input.requestBody,
  });

  await finishLlmTrace(pendingTrace, {
    ok: false,
    error: input.error,
  });
}

export async function listLlmTraceInteractions(): Promise<LlmTraceInteraction[]> {
  const localInteractions = listLocalTraceInteractions();

  if (process.env.DATABASE_URL) {
    try {
      const { db } = await import("../db/client");
      const { llmTraceInteractions: llmTraceInteractionsTable } = await import(
        "../db/schema"
      );
      const rows = await db
        .select()
        .from(llmTraceInteractionsTable)
        .orderBy(desc(llmTraceInteractionsTable.startedAt))
        .limit(MAX_TRACE_INTERACTIONS);

      return mergeTraceInteractions(
        rows.map(rowToTraceInteraction).filter(isTraceInteraction),
        localInteractions,
      );
    } catch (error) {
      console.error("[waxon] llm trace db read skipped", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  return localInteractions;
}

function listLocalTraceInteractions(): LlmTraceInteraction[] {
  return state.interactions.map((interaction) => ({
    ...interaction,
    calls: interaction.calls.map((call) => ({ ...call })),
  }));
}

function mergeTraceInteractions(
  persistedInteractions: LlmTraceInteraction[],
  localInteractions: LlmTraceInteraction[],
): LlmTraceInteraction[] {
  const byId = new Map<string, LlmTraceInteraction>();

  for (const interaction of persistedInteractions) {
    byId.set(interaction.id, interaction);
  }

  for (const interaction of localInteractions) {
    byId.set(interaction.id, interaction);
  }

  return [...byId.values()]
    .sort(
      (left, right) =>
        new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
    )
    .slice(0, MAX_TRACE_INTERACTIONS);
}

async function persistTraceInteraction(
  interaction: LlmTraceInteraction,
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }

  try {
    const { db } = await import("../db/client");
    const { llmTraceInteractions: llmTraceInteractionsTable } = await import(
      "../db/schema"
    );
    const row = traceInteractionToRow(interaction);

    await db
      .insert(llmTraceInteractionsTable)
      .values(row)
      .onConflictDoUpdate({
        target: llmTraceInteractionsTable.id,
        set: {
          title: row.title,
          kind: row.kind,
          startedAt: row.startedAt,
          status: row.status,
          calls: row.calls,
          updatedAt: row.updatedAt,
        },
      });
  } catch (error) {
    console.error("[waxon] llm trace db write skipped", {
      traceId: interaction.id,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

function traceInteractionToRow(
  interaction: LlmTraceInteraction,
): typeof llmTraceInteractions.$inferInsert {
  const startedAt = Date.parse(interaction.startedAt);

  return {
    id: interaction.id,
    title: interaction.title,
    kind: interaction.kind,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    status: interaction.status,
    calls: JSON.stringify(interaction.calls.map(compactTraceCallForPersistence)),
    updatedAt: Date.now(),
  };
}

export function compactTraceCallForPersistence(call: LlmTraceCall): LlmTraceCall {
  return {
    ...call,
    requestPayload: truncateTracePayload(call.requestPayload),
    responsePayload: truncateTracePayload(call.responsePayload),
  };
}

function truncateTracePayload(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_PERSISTED_TRACE_PAYLOAD_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_PERSISTED_TRACE_PAYLOAD_CHARS)}\n... [truncated ${value.length - MAX_PERSISTED_TRACE_PAYLOAD_CHARS} chars for trace persistence]`;
}

function rowToTraceInteraction(
  row: typeof llmTraceInteractions.$inferSelect,
): LlmTraceInteraction | null {
  let calls: unknown;

  try {
    calls = JSON.parse(row.calls);
  } catch {
    return null;
  }

  if (!Array.isArray(calls)) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    kind: isTraceInteractionKind(row.kind) ? row.kind : "Answer submitted",
    startedAt: new Date(row.startedAt).toISOString(),
    status: isTraceStatus(row.status) ? row.status : "error",
    calls: calls.filter(isTraceCall),
  };
}

function isTraceInteraction(
  interaction: LlmTraceInteraction | null,
): interaction is LlmTraceInteraction {
  return interaction !== null;
}

function isTraceInteractionKind(
  value: string,
): value is LlmTraceInteraction["kind"] {
  return (
    value === "Answer submitted" ||
    value === "Question generation" ||
    value === "Reference answer"
  );
}

function isTraceStatus(value: string): value is LlmTraceStatus {
  return value === "ok" || value === "pending" || value === "error";
}

function isTraceCallType(value: unknown): value is LlmTraceCallType {
  return (
    value === "answer_eval" ||
    value === "question_generation" ||
    value === "embedding" ||
    value === "summarization"
  );
}

function isTraceCall(value: unknown): value is LlmTraceCall {
  if (!value || typeof value !== "object") {
    return false;
  }

  const call = value as Partial<LlmTraceCall>;

  return (
    typeof call.id === "string" &&
    typeof call.operation === "string" &&
    typeof call.model === "string" &&
    isTraceCallType(call.callType) &&
    typeof call.inputTokens === "number" &&
    typeof call.outputTokens === "number" &&
    typeof call.cost === "number" &&
    typeof call.latencyMs === "number" &&
    isTraceStatus(call.status ?? "") &&
    typeof call.startedAt === "string"
  );
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
