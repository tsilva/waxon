"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowDownUp,
  CheckCircle2,
  ChevronDown,
  Clock3,
  RefreshCw,
  Search,
  SlidersHorizontal,
  User,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AuthenticatedUser } from "@/app/lib/auth";

type CallType =
  | "answer_eval"
  | "question_generation"
  | "embedding"
  | "summarization";

type TraceStatus = "ok" | "pending" | "error";

type LlmCall = {
  id: string;
  operation: string;
  model: string;
  callType: CallType;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  status: TraceStatus;
  startedAt: string;
  requestPayload?: string;
  responsePayload?: string;
};

type TraceInteraction = {
  id: string;
  title: string;
  kind: "Answer submitted" | "Question generation" | "Reference answer";
  startedAt: string;
  status: TraceStatus;
  calls: LlmCall[];
};

type SortKey = "startedAt" | "calls" | "tokens" | "cost" | "latency" | "status";
type SortDirection = "asc" | "desc";
type DatePreset = "7d" | "30d" | "custom";

type AdminPageClientProps = {
  currentUser: Pick<AuthenticatedUser, "displayName" | "email" | "avatarUrl">;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const callTypeLabels: Record<CallType, string> = {
  answer_eval: "answer eval",
  question_generation: "question generation",
  embedding: "embedding",
  summarization: "summarization",
};

const callTypeColors: Record<CallType, string> = {
  answer_eval: "#a67c52",
  question_generation: "#6b8e75",
  embedding: "#cc653c",
  summarization: "#8c5462",
};

const traceInteractions: TraceInteraction[] = [
  {
    id: "int-2039",
    title: "Answer submitted: data augmentation",
    kind: "Answer submitted",
    startedAt: "2026-06-05T09:12:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2039-1",
        operation: "evaluate_answer",
        model: "openai/gpt-5.5",
        callType: "answer_eval",
        inputTokens: 2320,
        outputTokens: 418,
        cost: 0.092,
        latencyMs: 5400,
        status: "ok",
        startedAt: "2026-06-05T09:12:01.000Z",
      },
      {
        id: "call-2039-2",
        operation: "rubric_context",
        model: "openai/gpt-5.5",
        callType: "summarization",
        inputTokens: 940,
        outputTokens: 188,
        cost: 0.033,
        latencyMs: 2100,
        status: "ok",
        startedAt: "2026-06-05T09:12:04.000Z",
      },
      {
        id: "call-2039-3",
        operation: "generate_feedback",
        model: "openai/gpt-5.5",
        callType: "answer_eval",
        inputTokens: 1560,
        outputTokens: 362,
        cost: 0.064,
        latencyMs: 3200,
        status: "ok",
        startedAt: "2026-06-05T09:12:06.000Z",
      },
      {
        id: "call-2039-4",
        operation: "save_summary",
        model: "openai/gpt-5.5",
        callType: "summarization",
        inputTokens: 680,
        outputTokens: 92,
        cost: 0.018,
        latencyMs: 900,
        status: "ok",
        startedAt: "2026-06-05T09:12:09.000Z",
      },
    ],
  },
  {
    id: "int-2038",
    title: "Question generation: CNN invariances",
    kind: "Question generation",
    startedAt: "2026-06-04T16:48:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2038-1",
        operation: "generate_questions_context_summary",
        model: "openai/gpt-5.5",
        callType: "summarization",
        inputTokens: 4210,
        outputTokens: 448,
        cost: 0.151,
        latencyMs: 6100,
        status: "ok",
        startedAt: "2026-06-04T16:48:01.000Z",
      },
      {
        id: "call-2038-2",
        operation: "generate_questions_summary_embedding",
        model: "openai/text-embedding-3-large",
        callType: "embedding",
        inputTokens: 512,
        outputTokens: 0,
        cost: 0.006,
        latencyMs: 760,
        status: "ok",
        startedAt: "2026-06-04T16:48:08.000Z",
      },
      {
        id: "call-2038-3",
        operation: "generate_questions",
        model: "openai/gpt-5.5",
        callType: "question_generation",
        inputTokens: 6100,
        outputTokens: 1510,
        cost: 0.286,
        latencyMs: 12200,
        status: "ok",
        startedAt: "2026-06-04T16:48:10.000Z",
      },
    ],
  },
  {
    id: "int-2037",
    title: "Answer submitted: optimizer momentum",
    kind: "Answer submitted",
    startedAt: "2026-06-04T10:21:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2037-1",
        operation: "evaluate_answer",
        model: "openai/gpt-5.5",
        callType: "answer_eval",
        inputTokens: 1880,
        outputTokens: 324,
        cost: 0.071,
        latencyMs: 4300,
        status: "ok",
        startedAt: "2026-06-04T10:21:01.000Z",
      },
    ],
  },
  {
    id: "int-2036",
    title: "Reference answer: batch normalization",
    kind: "Reference answer",
    startedAt: "2026-06-03T14:34:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2036-1",
        operation: "reference_answer",
        model: "openai/gpt-5.5",
        callType: "summarization",
        inputTokens: 1420,
        outputTokens: 402,
        cost: 0.061,
        latencyMs: 3800,
        status: "ok",
        startedAt: "2026-06-03T14:34:01.000Z",
      },
    ],
  },
  {
    id: "int-2035",
    title: "Question generation: transformers attention",
    kind: "Question generation",
    startedAt: "2026-06-02T18:02:00.000Z",
    status: "pending",
    calls: [
      {
        id: "call-2035-1",
        operation: "semantic_dedupe_embedding",
        model: "openai/text-embedding-3-large",
        callType: "embedding",
        inputTokens: 1840,
        outputTokens: 0,
        cost: 0.022,
        latencyMs: 1240,
        status: "ok",
        startedAt: "2026-06-02T18:02:02.000Z",
      },
      {
        id: "call-2035-2",
        operation: "semantic_dedupe_judge",
        model: "openai/gpt-5.5",
        callType: "question_generation",
        inputTokens: 7200,
        outputTokens: 930,
        cost: 0.247,
        latencyMs: 14700,
        status: "pending",
        startedAt: "2026-06-02T18:02:05.000Z",
      },
    ],
  },
  {
    id: "int-2034",
    title: "Answer submitted: PCA reconstruction",
    kind: "Answer submitted",
    startedAt: "2026-05-31T11:15:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2034-1",
        operation: "evaluate_answer",
        model: "openai/gpt-5.5",
        callType: "answer_eval",
        inputTokens: 2040,
        outputTokens: 376,
        cost: 0.081,
        latencyMs: 3900,
        status: "ok",
        startedAt: "2026-05-31T11:15:01.000Z",
      },
    ],
  },
  {
    id: "int-2033",
    title: "Question generation: calibration curves",
    kind: "Question generation",
    startedAt: "2026-05-28T12:02:00.000Z",
    status: "error",
    calls: [
      {
        id: "call-2033-1",
        operation: "generate_questions",
        model: "openai/gpt-5.5",
        callType: "question_generation",
        inputTokens: 5180,
        outputTokens: 120,
        cost: 0.118,
        latencyMs: 16800,
        status: "error",
        startedAt: "2026-05-28T12:02:01.000Z",
      },
    ],
  },
  {
    id: "int-2032",
    title: "Answer submitted: activation functions",
    kind: "Answer submitted",
    startedAt: "2026-05-25T08:44:00.000Z",
    status: "ok",
    calls: [
      {
        id: "call-2032-1",
        operation: "evaluate_answer",
        model: "openai/gpt-5.5",
        callType: "answer_eval",
        inputTokens: 1640,
        outputTokens: 288,
        cost: 0.058,
        latencyMs: 2900,
        status: "ok",
        startedAt: "2026-05-25T08:44:01.000Z",
      },
      {
        id: "call-2032-2",
        operation: "save_summary",
        model: "openai/gpt-5.5",
        callType: "summarization",
        inputTokens: 540,
        outputTokens: 84,
        cost: 0.015,
        latencyMs: 820,
        status: "ok",
        startedAt: "2026-05-25T08:44:04.000Z",
      },
    ],
  },
];

function sumInteraction(interaction: TraceInteraction) {
  return interaction.calls.reduce(
    (total, call) => ({
      calls: total.calls + 1,
      tokens: total.tokens + call.inputTokens + call.outputTokens,
      cost: total.cost + call.cost,
      latencyMs: total.latencyMs + call.latencyMs,
    }),
    { calls: 0, tokens: 0, cost: 0, latencyMs: 0 },
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatStartedAt(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function toInputDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function statusLabel(status: TraceStatus): string {
  if (status === "ok") {
    return "ok";
  }

  if (status === "pending") {
    return "pending";
  }

  return "error";
}

function StatusPill({ status }: { status: TraceStatus }) {
  const Icon = status === "ok" ? CheckCircle2 : Clock3;

  return (
    <span className={`admin-status admin-status-${status}`}>
      <Icon aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

function operationPrompt(call: LlmCall, interaction: TraceInteraction): string {
  if (call.operation.includes("embedding")) {
    return `Embed the source text for "${interaction.title}" so it can be compared with existing deck material.`;
  }

  if (call.operation.includes("generate_questions")) {
    return `Generate concise review questions for "${interaction.title}". Return only questions that test durable conceptual understanding.`;
  }

  if (call.operation.includes("reference_answer")) {
    return `Write a compact reference answer for the selected flashcard in "${interaction.title}".`;
  }

  if (call.operation.includes("feedback")) {
    return `Turn the evaluation notes for "${interaction.title}" into learner-facing feedback.`;
  }

  if (call.operation.includes("summary") || call.operation.includes("context")) {
    return `Summarize the relevant context for "${interaction.title}" while preserving technical constraints.`;
  }

  return `Evaluate the submitted answer for "${interaction.title}" against the expected rubric.`;
}

function operationResponse(call: LlmCall, interaction: TraceInteraction): string {
  if (call.status === "pending") {
    return "The provider has not returned a final response for this call yet.";
  }

  if (call.status === "error") {
    return "The provider returned an error before a complete response body was recorded.";
  }

  if (call.operation.includes("embedding")) {
    return "Embedding vector created and stored for semantic duplicate checks.";
  }

  if (call.operation.includes("generate_questions")) {
    return [
      `Generated review questions for ${interaction.title}:`,
      "1. Why does convolution preserve translation equivariance but not full invariance?",
      "2. How do pooling and global aggregation change the invariances of a CNN?",
      "3. What failure mode appears when an augmentation adds invariance the task does not support?",
    ].join("\n");
  }

  if (call.operation.includes("reference_answer")) {
    return "Batch normalization stabilizes intermediate activation statistics during training, which usually permits larger learning rates and improves optimization.";
  }

  if (call.operation.includes("feedback")) {
    return "The answer identified the high-level idea, but it should separate label-preserving transformations from regularization effects and mention when augmentation can hurt.";
  }

  if (call.operation.includes("summary") || call.operation.includes("context")) {
    return "Key rubric context retained: define the transformation, state the expected invariance or equivariance, and connect it to the model architecture.";
  }

  return JSON.stringify(
    {
      score: 4,
      justification:
        "The answer is mostly correct and identifies the central mechanism, with minor gaps in edge cases.",
    },
    null,
    2,
  );
}

function formatCallRequest(call: LlmCall, interaction: TraceInteraction): string {
  if (call.requestPayload) {
    return call.requestPayload;
  }

  if (call.callType === "embedding") {
    return JSON.stringify(
      {
        model: call.model,
        input: operationPrompt(call, interaction),
        metadata: {
          interactionId: interaction.id,
          callId: call.id,
          operation: call.operation,
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      model: call.model,
      messages: [
        {
          role: "system",
          content:
            "You are Waxon's LLM trace replay surface. Preserve technical precision and return concise structured output.",
        },
        {
          role: "user",
          content: operationPrompt(call, interaction),
        },
      ],
      metadata: {
        interactionId: interaction.id,
        callId: call.id,
        operation: call.operation,
      },
    },
    null,
    2,
  );
}

function formatCallResponse(call: LlmCall, interaction: TraceInteraction): string {
  if (call.responsePayload) {
    return call.responsePayload;
  }

  if (call.callType === "embedding") {
    return JSON.stringify(
      {
        model: call.model,
        data: [
          {
            object: "embedding",
            embedding: "[3072 floats omitted]",
          },
        ],
        usage: {
          prompt_tokens: call.inputTokens,
          total_tokens: call.inputTokens + call.outputTokens,
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      model: call.model,
      choices: [
        {
          message: {
            role: "assistant",
            content: operationResponse(call, interaction),
          },
        },
      ],
      usage: {
        prompt_tokens: call.inputTokens,
        completion_tokens: call.outputTokens,
        total_tokens: call.inputTokens + call.outputTokens,
      },
    },
    null,
    2,
  );
}

function stackSegmentPath({
  x,
  y,
  width,
  height,
  radius,
  roundTop,
  roundBottom,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  roundTop: boolean;
  roundBottom: boolean;
}) {
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height / 2);

  if (r <= 0 || (!roundTop && !roundBottom)) {
    return `M ${x} ${y} H ${right} V ${bottom} H ${x} Z`;
  }

  if (roundTop && roundBottom) {
    return [
      `M ${x + r} ${y}`,
      `H ${right - r}`,
      `Q ${right} ${y} ${right} ${y + r}`,
      `V ${bottom - r}`,
      `Q ${right} ${bottom} ${right - r} ${bottom}`,
      `H ${x + r}`,
      `Q ${x} ${bottom} ${x} ${bottom - r}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      "Z",
    ].join(" ");
  }

  if (roundTop) {
    return [
      `M ${x + r} ${y}`,
      `H ${right - r}`,
      `Q ${right} ${y} ${right} ${y + r}`,
      `V ${bottom}`,
      `H ${x}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      "Z",
    ].join(" ");
  }

  return [
    `M ${x} ${y}`,
    `H ${right}`,
    `V ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `H ${x + r}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    `V ${y}`,
    "Z",
  ].join(" ");
}

function CostChart({ interactions }: { interactions: TraceInteraction[] }) {
  const width = 920;
  const height = 260;
  const padding = { top: 22, right: 18, bottom: 38, left: 46 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const calls = interactions.flatMap((interaction) => interaction.calls);
  const days = Array.from(
    calls.reduce((set, call) => {
      set.add(call.startedAt.slice(0, 10));
      return set;
    }, new Set<string>()),
  ).sort();
  const stackedDays = days.map((day) => {
    const costs = Object.fromEntries(
      Object.keys(callTypeLabels).map((key) => [key, 0]),
    ) as Record<CallType, number>;

    calls
      .filter((call) => call.startedAt.startsWith(day))
      .forEach((call) => {
        costs[call.callType] += call.cost;
      });

    return {
      day,
      costs,
      total: Object.values(costs).reduce((sum, cost) => sum + cost, 0),
    };
  });
  const maxTotal = Math.max(0.1, ...stackedDays.map((day) => day.total));
  const barSlot = stackedDays.length > 0 ? plotWidth / stackedDays.length : plotWidth;
  const barWidth = Math.max(18, Math.min(58, barSlot * 0.54));
  const gridValues = [maxTotal, maxTotal / 2, 0];

  if (stackedDays.length === 0) {
    return (
      <div className="admin-chart-empty">
        No calls in the selected range.
      </div>
    );
  }

  return (
    <svg
      className="admin-cost-chart"
      role="img"
      aria-label="Cost per day by call type"
      viewBox={`0 0 ${width} ${height}`}
    >
      {gridValues.map((value) => {
        const y = padding.top + (1 - value / maxTotal) * plotHeight;

        return (
          <g key={value}>
            <line
              className="admin-chart-grid"
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
            />
            <text className="admin-chart-axis" x="8" y={y + 4}>
              {formatCurrency(value)}
            </text>
          </g>
        );
      })}
      {stackedDays.map((day, dayIndex) => {
        const x = padding.left + dayIndex * barSlot + (barSlot - barWidth) / 2;
        let stackY = padding.top + plotHeight;
        const visibleSegments = (Object.keys(callTypeLabels) as CallType[])
          .map((callType) => {
            const value = day.costs[callType];

            return {
              callType,
              height: (value / maxTotal) * plotHeight,
            };
          })
          .filter((segment) => segment.height > 0);

        return (
          <g key={day.day}>
            {visibleSegments.map((segment, segmentIndex) => {
              stackY -= segment.height;

              return (
                <path
                  className="admin-chart-bar"
                  key={segment.callType}
                  d={stackSegmentPath({
                    x,
                    y: stackY,
                    width: barWidth,
                    height: segment.height,
                    radius: 3,
                    roundTop: segmentIndex === visibleSegments.length - 1,
                    roundBottom: segmentIndex === 0,
                  })}
                  fill={callTypeColors[segment.callType]}
                />
              );
            })}
            <text
              className="admin-chart-date"
              x={x + barWidth / 2}
              y={height - 12}
              textAnchor="middle"
            >
              {new Date(`${day.day}T00:00:00`).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function AdminPageClient({ currentUser }: AdminPageClientProps) {
  const menuAvatarUrl = currentUser.avatarUrl;
  const latestDate = useMemo(
    () =>
      new Date(
        Math.max(
          ...traceInteractions.map((interaction) =>
            new Date(interaction.startedAt).getTime(),
          ),
        ),
      ),
    [],
  );
  const [preset, setPreset] = useState<DatePreset>("7d");
  const [fromDate, setFromDate] = useState(
    toInputDate(new Date(latestDate.getTime() - 6 * MS_PER_DAY)),
  );
  const [toDate, setToDate] = useState(toInputDate(latestDate));
  const [typeFilter, setTypeFilter] = useState<"all" | CallType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | TraceStatus>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("startedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expandedInteractionId, setExpandedInteractionId] = useState("int-2039");
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  function setPresetRange(nextPreset: DatePreset) {
    setPreset(nextPreset);

    if (nextPreset === "custom") {
      return;
    }

    const days = nextPreset === "7d" ? 7 : 30;
    setFromDate(toInputDate(new Date(latestDate.getTime() - (days - 1) * MS_PER_DAY)));
    setToDate(toInputDate(latestDate));
  }

  function updateSort(nextSortKey: SortKey) {
    if (nextSortKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection(nextSortKey === "status" ? "asc" : "desc");
  }

  const filteredInteractions = useMemo(() => {
    const fromTime = new Date(`${fromDate}T00:00:00`).getTime();
    const toTime = new Date(`${toDate}T23:59:59`).getTime();
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return traceInteractions
      .filter((interaction) => {
        const startedAt = new Date(interaction.startedAt).getTime();
        const matchesDate = startedAt >= fromTime && startedAt <= toTime;
        const matchesStatus =
          statusFilter === "all" || interaction.status === statusFilter;
        const matchesType =
          typeFilter === "all" ||
          interaction.calls.some((call) => call.callType === typeFilter);
        const matchesSearch =
          !normalizedSearch ||
          interaction.title.toLowerCase().includes(normalizedSearch) ||
          interaction.id.toLowerCase().includes(normalizedSearch) ||
          interaction.calls.some((call) =>
            `${call.id} ${call.operation} ${call.model}`
              .toLowerCase()
              .includes(normalizedSearch),
          );

        return matchesDate && matchesStatus && matchesType && matchesSearch;
      })
      .sort((left, right) => {
        const leftTotals = sumInteraction(left);
        const rightTotals = sumInteraction(right);
        const direction = sortDirection === "asc" ? 1 : -1;

        const sortValue =
          sortKey === "startedAt"
            ? new Date(left.startedAt).getTime() -
              new Date(right.startedAt).getTime()
            : sortKey === "calls"
              ? leftTotals.calls - rightTotals.calls
              : sortKey === "tokens"
                ? leftTotals.tokens - rightTotals.tokens
                : sortKey === "cost"
                  ? leftTotals.cost - rightTotals.cost
                  : sortKey === "latency"
                    ? leftTotals.latencyMs - rightTotals.latencyMs
                    : left.status.localeCompare(right.status);

        return sortValue * direction;
      });
  }, [fromDate, searchTerm, sortDirection, sortKey, statusFilter, toDate, typeFilter]);

  const selectedCallContext = useMemo(() => {
    if (!selectedCallId) {
      return null;
    }

    for (const interaction of traceInteractions) {
      const call = interaction.calls.find((candidate) => candidate.id === selectedCallId);

      if (call) {
        return { call, interaction };
      }
    }

    return null;
  }, [selectedCallId]);

  useEffect(() => {
    if (!selectedCallContext) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedCallId(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCallContext]);

  const totals = filteredInteractions.reduce(
    (current, interaction) => {
      const interactionTotals = sumInteraction(interaction);

      return {
        calls: current.calls + interactionTotals.calls,
        tokens: current.tokens + interactionTotals.tokens,
        cost: current.cost + interactionTotals.cost,
        latencyMs: current.latencyMs + interactionTotals.latencyMs,
        interactions: current.interactions + 1,
      };
    },
    { calls: 0, tokens: 0, cost: 0, latencyMs: 0, interactions: 0 },
  );
  const averageCost =
    totals.interactions === 0 ? 0 : totals.cost / totals.interactions;
  const rangeLabel = `${fromDate} to ${toDate}`;

  return (
    <main className="page admin-page">
      <section className="review-shell admin-shell" aria-label="Admin traces">
        <header className="reader-header">
          <div className="reader-heading">
            <Link className="reader-brand admin-brand-link" href="/">
              <Image
                className="reader-brand-mark"
                src="/brand/icon/header-mark.svg"
                alt=""
                aria-hidden="true"
                width={34}
                height={34}
              />
              <span>waxon</span>
            </Link>
            <div className="reader-tabs" role="tablist" aria-label="Waxon views">
              <Link className="reader-tab" href="/review" role="tab" aria-selected="false">
                Review
              </Link>
              <Link className="reader-tab" href="/queue" role="tab" aria-selected="false">
                Queue
              </Link>
              <span className="reader-tab reader-tab-active" role="tab" aria-selected="true">
                Admin
              </span>
            </div>
          </div>

          <div className="reader-actions">
            <span className="queue-summary">149 due</span>
            <div className="user-menu">
              <button
                className="user-menu-trigger"
                type="button"
                aria-label="User menu"
                title={currentUser.displayName || currentUser.email}
              >
                {menuAvatarUrl ? (
                  <span
                    className="user-avatar-image"
                    aria-hidden="true"
                    style={{ backgroundImage: `url("${menuAvatarUrl}")` }}
                  />
                ) : (
                  <User aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </header>

        <div className="admin-stage">
          <section className="admin-heading-row">
            <div>
              <p className="admin-kicker">Observability</p>
              <h1>Admin traces</h1>
              <p>LLM activity grouped by user interaction.</p>
            </div>
            <div className="admin-range-controls" aria-label="Date range controls">
              <div className="admin-segmented" aria-label="Date preset">
                {(["7d", "30d", "custom"] as DatePreset[]).map((option) => (
                  <button
                    className={preset === option ? "admin-segment-active" : ""}
                    key={option}
                    type="button"
                    onClick={() => setPresetRange(option)}
                  >
                    {option === "custom" ? "Custom" : option}
                  </button>
                ))}
              </div>
              <label>
                <span>From</span>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(event) => {
                    setPreset("custom");
                    setFromDate(event.target.value);
                  }}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(event) => {
                    setPreset("custom");
                    setToDate(event.target.value);
                  }}
                />
              </label>
              <button className="admin-icon-button" type="button" aria-label="Refresh traces">
                <RefreshCw aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="admin-metrics" aria-label="Current range totals">
            <div>
              <span>Total cost</span>
              <strong>{formatCurrency(totals.cost)}</strong>
              <small>{rangeLabel}</small>
            </div>
            <div>
              <span>LLM calls</span>
              <strong>{formatNumber(totals.calls)}</strong>
              <small>{formatNumber(totals.tokens)} tokens</small>
            </div>
            <div>
              <span>Interactions</span>
              <strong>{formatNumber(totals.interactions)}</strong>
              <small>{filteredInteractions.length} visible groups</small>
            </div>
            <div>
              <span>Avg / interaction</span>
              <strong>{formatCurrency(averageCost)}</strong>
              <small>{Math.round(totals.latencyMs / Math.max(1, totals.calls))}ms avg call</small>
            </div>
          </section>

          <section className="admin-chart-panel" aria-labelledby="admin-cost-heading">
            <div className="admin-section-heading">
              <div>
                <h2 id="admin-cost-heading">Cost per day</h2>
                <p>Stratified by call type.</p>
              </div>
              <div className="admin-legend">
                {(Object.keys(callTypeLabels) as CallType[]).map((callType) => (
                  <span key={callType}>
                    <i style={{ backgroundColor: callTypeColors[callType] }} />
                    {callTypeLabels[callType]}
                  </span>
                ))}
              </div>
            </div>
            <div className="admin-chart-scroll">
              <CostChart interactions={filteredInteractions} />
            </div>
          </section>

          <section className="admin-table-panel" aria-labelledby="admin-table-heading">
            <div className="admin-section-heading admin-table-heading">
              <div>
                <h2 id="admin-table-heading">Trace groups</h2>
                <p>Expand an interaction to inspect the individual LLM calls.</p>
              </div>
              <div className="admin-filter-row">
                <label>
                  <SlidersHorizontal aria-hidden="true" />
                  <select
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value as "all" | CallType)}
                    aria-label="Filter by call type"
                  >
                    <option value="all">type: all</option>
                    {(Object.keys(callTypeLabels) as CallType[]).map((callType) => (
                      <option key={callType} value={callType}>
                        type: {callTypeLabels[callType]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <CheckCircle2 aria-hidden="true" />
                  <select
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as "all" | TraceStatus)
                    }
                    aria-label="Filter by status"
                  >
                    <option value="all">status: all</option>
                    <option value="ok">status: ok</option>
                    <option value="pending">status: pending</option>
                    <option value="error">status: error</option>
                  </select>
                </label>
                <label className="admin-search-field">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={searchTerm}
                    placeholder="search trace id"
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="admin-table-scroll">
            <div className="admin-trace-table" role="table" aria-label="Trace groups">
              <div className="admin-trace-header" role="row">
                <span role="columnheader">Interaction</span>
                {[
                  ["startedAt", "Started"],
                  ["calls", "Calls"],
                  ["tokens", "Tokens"],
                  ["cost", "Cost"],
                  ["latency", "Latency"],
                  ["status", "Status"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="columnheader"
                    onClick={() => updateSort(key as SortKey)}
                  >
                    {label}
                    <ArrowDownUp aria-hidden="true" />
                  </button>
                ))}
              </div>

              {filteredInteractions.map((interaction) => {
                const summary = sumInteraction(interaction);
                const isExpanded = expandedInteractionId === interaction.id;

                return (
                  <div
                    className={`admin-trace-group ${
                      isExpanded ? "admin-trace-group-expanded" : ""
                    }`}
                    key={interaction.id}
                    role="rowgroup"
                  >
                    <button
                      className="admin-trace-row admin-trace-group-row"
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpandedInteractionId(isExpanded ? "" : interaction.id)
                      }
                    >
                      <span className="admin-interaction-cell">
                        <ChevronDown aria-hidden="true" />
                        <strong>{interaction.title}</strong>
                        <small>{interaction.kind} · {interaction.id}</small>
                      </span>
                      <span>{formatStartedAt(interaction.startedAt)}</span>
                      <span>{summary.calls}</span>
                      <span>{formatNumber(summary.tokens)}</span>
                      <span>{formatCurrency(summary.cost)}</span>
                      <span>{(summary.latencyMs / 1000).toFixed(1)}s</span>
                      <StatusPill status={interaction.status} />
                    </button>

                    {isExpanded ? (
                      <div className="admin-call-list">
                        {interaction.calls.map((call) => (
                          <button
                            className="admin-call-row"
                            key={call.id}
                            type="button"
                            aria-label={`Open LLM call details for ${call.operation}`}
                            onClick={() => setSelectedCallId(call.id)}
                          >
                            <span className="admin-call-name">
                              <strong>{call.operation}</strong>
                              <small>{call.model} · {call.id}</small>
                            </span>
                            <span>{callTypeLabels[call.callType]}</span>
                            <span>{formatNumber(call.inputTokens)} in</span>
                            <span>{formatNumber(call.outputTokens)} out</span>
                            <span>{formatCurrency(call.cost)}</span>
                            <span>{(call.latencyMs / 1000).toFixed(1)}s</span>
                            <StatusPill status={call.status} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            </div>
          </section>
        </div>
      </section>
      {selectedCallContext ? (
        <div
          className="admin-call-modal-backdrop"
          role="presentation"
          onClick={() => setSelectedCallId(null)}
        >
          <section
            className="admin-call-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-call-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="admin-call-modal-header">
              <div>
                <p className="admin-call-modal-kicker">
                  {selectedCallContext.call.id}
                </p>
                <h2 className="admin-call-modal-title" id="admin-call-modal-title">
                  {selectedCallContext.call.operation}
                </h2>
                <p className="admin-call-modal-subtitle">
                  {selectedCallContext.interaction.title} ·{" "}
                  {formatStartedAt(selectedCallContext.call.startedAt)}
                </p>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close LLM call details"
                onClick={() => setSelectedCallId(null)}
              />
            </header>

            <div className="admin-call-modal-meta" aria-label="LLM call metadata">
              <div>
                <span>Model</span>
                <strong>{selectedCallContext.call.model}</strong>
              </div>
              <div>
                <span>Type</span>
                <strong>{callTypeLabels[selectedCallContext.call.callType]}</strong>
              </div>
              <div>
                <span>Tokens</span>
                <strong>
                  {formatNumber(selectedCallContext.call.inputTokens)} in ·{" "}
                  {formatNumber(selectedCallContext.call.outputTokens)} out
                </strong>
              </div>
              <div>
                <span>Cost</span>
                <strong>{formatCurrency(selectedCallContext.call.cost)}</strong>
              </div>
              <div>
                <span>Latency</span>
                <strong>
                  {(selectedCallContext.call.latencyMs / 1000).toFixed(1)}s
                </strong>
              </div>
              <div>
                <span>Status</span>
                <StatusPill status={selectedCallContext.call.status} />
              </div>
            </div>

            <div className="admin-call-payload-grid">
              <section className="admin-call-payload-panel">
                <div className="admin-call-payload-heading">
                  <h3>Request sent</h3>
                  <span>{formatNumber(selectedCallContext.call.inputTokens)} tokens</span>
                </div>
                <pre>{formatCallRequest(
                  selectedCallContext.call,
                  selectedCallContext.interaction,
                )}</pre>
              </section>
              <section className="admin-call-payload-panel">
                <div className="admin-call-payload-heading">
                  <h3>Response received</h3>
                  <span>{formatNumber(selectedCallContext.call.outputTokens)} tokens</span>
                </div>
                <pre>{formatCallResponse(
                  selectedCallContext.call,
                  selectedCallContext.interaction,
                )}</pre>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
