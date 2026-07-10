import type {
  LlmTraceCallType,
  LlmTraceStatus,
} from "@/app/lib/llmTraceStore";

export type CallType = LlmTraceCallType;

export type TraceStatus = LlmTraceStatus;

export type SortKey =
  | "startedAt"
  | "calls"
  | "tokens"
  | "cost"
  | "latency"
  | "status";

export type SortDirection = "asc" | "desc";
export type DatePreset = "7d" | "30d" | "custom";
