export type CallType =
  | "answer_eval"
  | "question_generation"
  | "embedding"
  | "summarization";

export type TraceStatus = "ok" | "pending" | "error";

export type SortKey =
  | "startedAt"
  | "calls"
  | "tokens"
  | "cost"
  | "latency"
  | "status";

export type SortDirection = "asc" | "desc";
export type DatePreset = "7d" | "30d" | "custom";
