import type {
  CallType,
  DatePreset,
  SortDirection,
  SortKey,
  TraceStatus,
} from "./AdminPageClient";

export const ADMIN_VIEW_STATE_COOKIE = "waxon_admin_view_state";

export type AdminCachedViewState = {
  preset: DatePreset;
  fromDate: string;
  toDate: string;
  typeFilter: "all" | CallType;
  statusFilter: "all" | TraceStatus;
  searchTerm: string;
  sortKey: SortKey;
  sortDirection: SortDirection;
  expandedInteractionId: string;
};

function isDatePreset(value: unknown): value is DatePreset {
  return value === "7d" || value === "30d" || value === "custom";
}

function isSortKey(value: unknown): value is SortKey {
  return (
    value === "startedAt" ||
    value === "calls" ||
    value === "tokens" ||
    value === "cost" ||
    value === "latency" ||
    value === "status"
  );
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function isTypeFilter(value: unknown): value is "all" | CallType | undefined {
  return (
    value === undefined ||
    value === "all" ||
    value === "answer_eval" ||
    value === "question_generation" ||
    value === "embedding" ||
    value === "summarization"
  );
}

function isStatusFilter(
  value: unknown,
): value is "all" | TraceStatus | undefined {
  return (
    value === undefined ||
    value === "all" ||
    value === "ok" ||
    value === "pending" ||
    value === "error"
  );
}

export function parseAdminViewStateCookie(
  value: string | undefined,
): AdminCachedViewState | null {
  if (!value) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const state = parsed as Partial<AdminCachedViewState>;

  if (
    !isDatePreset(state.preset) ||
    typeof state.fromDate !== "string" ||
    typeof state.toDate !== "string" ||
    typeof state.searchTerm !== "string" ||
    !isSortKey(state.sortKey) ||
    !isSortDirection(state.sortDirection) ||
    !isTypeFilter(state.typeFilter) ||
    !isStatusFilter(state.statusFilter) ||
    typeof state.expandedInteractionId !== "string"
  ) {
    return null;
  }

  return {
    preset: state.preset,
    fromDate: state.fromDate,
    toDate: state.toDate,
    typeFilter: state.typeFilter ?? "all",
    statusFilter: state.statusFilter ?? "all",
    searchTerm: state.searchTerm,
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
    expandedInteractionId: state.expandedInteractionId,
  };
}
