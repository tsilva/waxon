"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { calculateQuestionExtractionProgress } from "@/app/lib/questionGenerationProgress";
import {
  MarkdownContent as SharedMarkdownContent,
  MarkdownInline as SharedMarkdownInline,
} from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import type {
  DeckEmbeddingPlot as DeckEmbeddingPlotResponse,
  DeckEmbeddingPlotPoint,
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
  ReviewHistoryEntry,
  ReviewQueueItem,
} from "@/app/lib/reviewTypes";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Info,
  Layers,
  Mic,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type NextQuestionResponse = {
  questionId: string | null;
  question: string | null;
  deckId: string | null;
  deckName: string | null;
  queueRemaining: number;
};

type LearnPanelMode = "review" | "learn";

type PrefetchedNextQuestion = {
  mode: LearnPanelMode;
  deckId: string | null;
  excludeQuestionId: string | null;
  excludeQuestion: string;
  data: NextQuestionResponse;
};

type NextQuestionPrefetch = {
  mode: LearnPanelMode;
  deckId: string | null;
  excludeQuestionId: string | null;
  excludeQuestion: string;
  abortController: AbortController;
  promise: Promise<PrefetchedNextQuestion | null>;
};

type SubmitAnswerResponse =
  | {
      ok: true;
      evaluationId: string;
      traceId: string;
    }
  | {
      ok: false;
      error: string;
    };

type QueueStatusResponse = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts?: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal?: number;
  reviewQueueOffset?: number;
  reviewQueueLimit?: number;
  reviewQueueHasMore?: boolean;
  deckEmbeddingPlot: DeckEmbeddingPlotResponse;
};

type EvaluationStatusResponse = {
  evaluations: EvaluationQueueItem[];
};

type ReferenceAnswerResponse = {
  answer: string;
};

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type ReferenceAnswerState = {
  status: "loading" | "resolved" | "error";
  answer: string;
};

type HoveredEmbeddingPoint = DeckEmbeddingPlotPoint & {
  arrowLeftPx: number;
  tooltipLeftPx: number;
  tooltipTopPx: number;
  verticalPlacement: "above" | "below";
  statusLabel: string;
  scoreLabel: string | null;
};

type ChatMessage =
  | {
      id: string;
      kind: "question";
      question: string;
    }
  | {
      id: string;
      kind: "answer";
      questionId: string | null;
      deckId: string | null;
      question: string;
      answer: string;
      evaluationId: string;
      traceId: string;
      submittedAt: number;
      status: "grading" | "resolved";
      isOptimistic?: boolean;
      phase: EvaluationPhase | null;
      lastActivityAt: number;
      score: number | null;
      justification: string | null;
      answerSummary: string | null;
      nextDue: number | null;
      resolvedAt: number | null;
    };

type PreviousAnswerItem = {
  id: string;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number | null;
  score: number | null;
  justification: string | null;
  traceId: string | null;
  timestamp: number | null;
  timeLabel: string;
};

type ActiveTab = "review" | "queue";

type ReviewAppProps = {
  initialActiveTab?: ActiveTab;
  initialDeckSlug?: string | null;
  initialDecks?: DeckManagementItem[];
};

type ReviewSessionSnapshot = {
  learnPanelMode: LearnPanelMode;
  currentQuestionId: string | null;
  question: string | null;
  currentDeckId: string | null;
  currentDeckName: string | null;
  answer: string;
  speechPreview: string;
  queueRemaining: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal: number;
  queueVirtualRange: {
    start: number;
    end: number;
  };
  queueSortKey: QueueSortKey;
  decks: DeckManagementItem[];
  selectedDeckId: string;
  deckSearchQuery: string;
  deckSortKey: DeckSortKey;
  selectedDeckDetailId: string | null;
  isCreatingDeck: boolean;
  editingDeckId: string | null;
  deckDraftName: string;
  deckDraftCoverage: string;
  deckEmbeddingPlot: DeckEmbeddingPlotResponse;
  messages: ChatMessage[];
  referenceAnswers: Record<string, ReferenceAnswerState>;
  isPreviousExpanded: boolean;
  expandedPreviousAnswerIds: Set<string>;
  selectedQuestionId: string | null;
  selectedQuestion: string | null;
  currentUser: UserProfileResponse | null;
  generatorScope: string;
  generatorQuestionCount: number;
  generatorFiles: GeneratorContextFile[];
  generatedQuestions: GeneratedQuestionCandidate[];
  generatorMessage: string | null;
  hasLoadedQuestion: boolean;
  hasLoadedQueueStatus: boolean;
  hasLoadedDecks: boolean;
  loadedQueueSortKey: QueueSortKey | null;
  queueLoadedLimit: number;
};

let reviewSessionSnapshot: ReviewSessionSnapshot | null = null;

const REVIEW_TAB_PATHS: Record<ActiveTab, string> = {
  review: "/review",
  queue: "/decks",
};
const LEARN_TARGET_DECK_STORAGE_KEY = "waxon:learn-target-deck-id";

type ReviewRouteState = {
  activeTab: ActiveTab;
  deckSlug: string | null;
};

function deckPath(deckSlug?: string | null): string {
  return deckSlug ? `/decks/${encodeURIComponent(deckSlug)}` : REVIEW_TAB_PATHS.queue;
}

function getStoredLearnTargetDeckId() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(LEARN_TARGET_DECK_STORAGE_KEY);
}

function storeLearnTargetDeckId(deckId: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (deckId) {
    window.sessionStorage.setItem(LEARN_TARGET_DECK_STORAGE_KEY, deckId);
  } else {
    window.sessionStorage.removeItem(LEARN_TARGET_DECK_STORAGE_KEY);
  }
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }

  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

async function readJsonResponse<T>(
  response: Response,
  fallbackError: string,
): Promise<T> {
  const text = await response.text();
  let data: unknown = {};

  if (text.trim()) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new Error(fallbackError);
    }
  }

  if (!response.ok) {
    const payload = data as { error?: unknown };
    throw new Error(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallbackError,
    );
  }

  return data as T;
}

function toLearnGenerationProgress(
  payload: Extract<TopUpStreamPayload, { ok: true }>,
  fallbackTotal: number,
): LearnGenerationProgress | null {
  if (!payload.phase || !payload.status) {
    return null;
  }

  const generated = Math.max(0, Math.round(payload.generated ?? 0));
  const total = Math.max(1, Math.round(payload.total ?? fallbackTotal));

  return {
    phase: payload.phase,
    status: payload.status,
    progress: calculateQuestionExtractionProgress({ generated, total }),
    generated,
    total,
    latestQuestion: payload.latestQuestion ?? null,
  };
}

async function parseTopUpResponse(
  response: Response,
  fallbackTotal: number,
  onProgress: (progress: LearnGenerationProgress) => void,
): Promise<Extract<TopUpQuestionsResponse, { ok: true }>> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.body || !contentType.includes("text/event-stream")) {
    const data = await readJsonResponse<TopUpQuestionsResponse>(
      response,
      "Could not generate questions.",
    );

    if (!data.ok) {
      throw new Error(
        data.error ? data.error : "Could not generate questions.",
      );
    }

    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Extract<TopUpQuestionsResponse, { ok: true }> | null = null;

  const parseEvent = (eventText: string) => {
    const lines = eventText.split("\n");
    const eventName =
      lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim() ?? "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (!dataText) {
      return;
    }

    const payload = JSON.parse(dataText) as TopUpStreamPayload;

    if (!payload.ok) {
      throw new Error(payload.error ?? "Could not generate questions.");
    }

    const progress = toLearnGenerationProgress(payload, fallbackTotal);

    if (progress) {
      onProgress(progress);
    }

    if (eventName === "complete") {
      completed = {
        ok: true,
        model: payload.model ?? "",
        deckId: payload.deckId ?? "",
        deckName: payload.deckName ?? "deck",
        memoryUpdated: Boolean(payload.memoryUpdated),
        generated: Math.max(0, Math.round(payload.generated ?? 0)),
        added: Math.max(0, Math.round(payload.added ?? 0)),
        rejected: Math.max(0, Math.round(payload.rejected ?? 0)),
      };
    }
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let eventBoundary = buffer.indexOf("\n\n");

    while (eventBoundary !== -1) {
      parseEvent(buffer.slice(0, eventBoundary));
      buffer = buffer.slice(eventBoundary + 2);
      eventBoundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    parseEvent(buffer);
  }

  if (!response.ok) {
    throw new Error("Could not generate questions.");
  }

  if (!completed) {
    throw new Error("Question generation stream ended before completion.");
  }

  return completed;
}

function getReviewRouteStateFromPathname(pathname: string): ReviewRouteState | null {
  if (pathname === REVIEW_TAB_PATHS.review) {
    return {
      activeTab: "review",
      deckSlug: null,
    };
  }

  if (pathname === REVIEW_TAB_PATHS.queue) {
    return {
      activeTab: "queue",
      deckSlug: null,
    };
  }

  if (pathname.startsWith(`${REVIEW_TAB_PATHS.queue}/`)) {
    const deckSlug = pathname.slice(REVIEW_TAB_PATHS.queue.length + 1);

    return {
      activeTab: "queue",
      deckSlug: deckSlug ? decodeURIComponent(deckSlug) : null,
    };
  }

  return null;
}

type QueueSortKey = "review-date" | "creation-date";

type DeckSortKey = "updated" | "due" | "name";

type DeckManagementItem = {
  id: string;
  name: string;
  slug: string;
  coverage: string;
  dueCount: number;
  cardCount: number;
  lastReviewedAt: number | null;
  inReviewRotation: boolean;
};

const deckLoadingRows = Array.from({ length: 4 }, (_, index) => index);

function DeckListLoadingPlaceholders() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading decks
      </span>
      <ol className="queue-list deck-list deck-skeleton-list" aria-hidden="true">
        {deckLoadingRows.map((row) => (
          <li className="queue-row deck-row deck-skeleton-row" key={row}>
            <div className="queue-row-card deck-row-card deck-skeleton-card">
              <div className="deck-row-main">
                <div className="deck-row-copy deck-skeleton-copy">
                  <span className="admin-skeleton-line deck-skeleton-name" />
                  <span className="admin-skeleton-line deck-skeleton-slug" />
                </div>
                <div className="deck-row-meta deck-skeleton-meta">
                  <span className="admin-skeleton-pill deck-skeleton-due" />
                  <span className="admin-skeleton-line deck-skeleton-count" />
                  <span className="admin-skeleton-line deck-skeleton-date" />
                </div>
              </div>
              <div className="deck-row-actions">
                <span className="deck-skeleton-toggle" />
                <span className="admin-skeleton-refresh deck-skeleton-button" />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

type DecksResponse = {
  decks: DeckManagementItem[];
};

type DeckMutationResponse = {
  ok: boolean;
  deck?: DeckManagementItem;
  error?: string;
};

type GeneratedQuestionStatus = "new" | "selected" | "adding" | "added";

type GeneratedQuestionCandidate = {
  id: string;
  question: string;
  conciseAnswer: string;
  coverageLabel: string;
  status: GeneratedQuestionStatus;
};

type GeneratorContextFile = {
  id: string;
  name: string;
  content: string;
  status: "ready" | "metadata-only";
};

type GenerateQuestionsResponse =
  | {
      ok: true;
      model: string;
      questions: Array<{
        question: string;
        conciseAnswer?: string;
        coverageLabel?: string;
      }>;
    }
  | {
      ok: false;
      error?: string;
    };

type TopUpQuestionsResponse =
  | {
      ok: true;
      model: string;
      deckId: string;
      deckName: string;
      memoryUpdated: boolean;
      generated: number;
      added: number;
      rejected: number;
    }
  | {
      ok: false;
      error?: string;
    };

type LearnGenerationPhase =
  | "memory"
  | "generating"
  | "processing"
  | "complete";

type LearnGenerationProgress = {
  phase: LearnGenerationPhase;
  status: string;
  progress: number;
  generated: number;
  total: number;
  latestQuestion: string | null;
};

type TopUpStreamPayload =
  | {
      ok: true;
      phase?: LearnGenerationPhase;
      status?: string;
      progress?: number;
      generated?: number;
      total?: number;
      latestQuestion?: string | null;
      model?: string;
      deckId?: string;
      deckName?: string;
      memoryUpdated?: boolean;
      added?: number;
      rejected?: number;
    }
  | {
      ok: false;
      error?: string;
    };

type PendingSpeechCommand = {
  command: "skip" | "submit";
  heldText: string;
  submitAnswer: string;
};

function nextQuestionUrl(input: {
  mode?: LearnPanelMode;
  deckId?: string | null;
  excludeQuestionId?: string | null;
  excludeQuestion?: string | null;
} = {}) {
  const params = new URLSearchParams();

  if (input.mode) {
    params.set("mode", input.mode);
  }

  if (input.deckId) {
    params.set("deckId", input.deckId);
  }

  if (input.excludeQuestionId) {
    params.set("excludeQuestionId", input.excludeQuestionId);
  }

  if (input.excludeQuestion) {
    params.set("excludeQuestion", input.excludeQuestion);
  }

  return params.size > 0
    ? `/api/next-question?${params.toString()}`
    : "/api/next-question";
}

async function fetchNextQuestionData(input: {
  mode?: LearnPanelMode;
  deckId?: string | null;
  excludeQuestionId?: string | null;
  excludeQuestion?: string | null;
  signal?: AbortSignal;
} = {}): Promise<NextQuestionResponse> {
  const response = await fetch(nextQuestionUrl(input), {
    cache: "no-store",
    signal: input.signal,
  });

  return await readJsonResponse<NextQuestionResponse>(
    response,
    "Failed to load the next question.",
  );
}

type SpeechStatus =
  | "idle"
  | "starting"
  | "listening"
  | "unsupported"
  | "error";

type SpeechRecognitionAlternative = {
  transcript: string;
};

type SpeechRecognitionResult = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultList = {
  length: number;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type QuestionStats = {
  questionId: string | null;
  question: string;
  reviewHistory: ReviewHistoryEntry[];
  answerHistory: AnswerHistoryEntry[];
  attempts: number;
  averageScore: number | null;
  bestScore: number | null;
  lastScore: number | null;
  lastReviewedAt: number | null;
  nextDue: number | null;
  msUntilDue: number | null;
  dueStatus: "now" | "scheduled" | "unknown";
  pendingCount: number;
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
};

type AnswerHistoryEntry = {
  id: string;
  rawAnswer: string;
  answerSummary: string | null;
  score: number | null;
  justification: string | null;
  traceId: string | null;
  submittedAt: number;
  resolvedAt: number | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number | null;
};

const COLLAPSED_PREVIOUS_ANSWER_LIMIT = 2;
const EXPANDED_PREVIOUS_ANSWER_LIMIT = 24;
const QUEUE_PAGE_SIZE = 48;
const QUEUE_PAGE_GROWTH_FACTOR = 1.75;
const QUEUE_ROW_ESTIMATED_HEIGHT = 132;
const QUEUE_ROW_OVERSCAN = 14;
const SPEECH_COMMAND_SETTLE_MS = 1000;
const STALE_EVALUATION_GRADING_MS = 120_000;
const EVALUATION_STATUS_POLL_MS = 750;
const LEARN_TOP_UP_COOLDOWN_MS = 20_000;

function createEmptyDeckEmbeddingPlot(): DeckEmbeddingPlotResponse {
  return {
    model: null,
    totalQuestions: 0,
    embeddedQuestions: 0,
    points: [],
  };
}
const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;
const TERMINAL_SPEECH_COMMAND = /(?:^|\s)(submit|skip)[.!?]*$/i;
const DEFAULT_GENERATED_QUESTION_COUNT = 5;
const MAX_GENERATED_QUESTION_COUNT = 10;

function MarkdownInline(
  props: Omit<ComponentProps<typeof SharedMarkdownInline>, "enableMath">,
) {
  return <SharedMarkdownInline enableMath {...props} />;
}

function MarkdownContent(
  props: Omit<ComponentProps<typeof SharedMarkdownContent>, "enableMath">,
) {
  return <SharedMarkdownContent enableMath {...props} />;
}

function formatDurationBadge(msUntilDue: number): string {
  if (msUntilDue <= 0) {
    return "NOW";
  }

  const totalSeconds = Math.ceil(msUntilDue / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function normalizeDeckNameForComparison(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

function formatDueBadge(item: ReviewQueueItem): string {
  return formatDurationBadge(item.msUntilDue);
}

function scoreTone(score: number | null) {
  if (score === null) {
    return "neutral";
  }

  if (score <= 3) {
    return "low";
  }

  if (score <= 7) {
    return "medium";
  }

  return "high";
}

function formatEvaluationPhase(phase: EvaluationPhase | null): string {
  switch (phase) {
    case "queued":
      return "Queued for evaluation";
    case "evaluating-answer":
      return "Waiting for evaluator";
    case "saving-evaluation":
      return "Saving evaluation";
    case "finalizing":
      return "Finalizing evaluation";
    default:
      return "Evaluating in background";
  }
}

function formatEvaluationActivity(
  lastActivityAt: number | null,
  currentTime: number,
): string {
  if (lastActivityAt === null) {
    return "Activity pending";
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((currentTime - lastActivityAt) / 1000),
  );

  if (elapsedSeconds < 2) {
    return "Active now";
  }

  if (elapsedSeconds < 60) {
    return `Active ${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  return `Active ${elapsedMinutes}m ago`;
}

function PreviousAnswerScore({
  score,
  className,
  label,
}: {
  score: number | null;
  className?: string;
  label?: string;
}) {
  const displayScore = score === null ? "-" : score;
  const accessibleLabel = label ?? (
    score === null ? "No score" : `Score ${score} out of 10`
  );

  return (
    <span
      className={`previous-score-shell${className ? ` ${className}` : ""}`}
      aria-label={accessibleLabel}
    >
      <span className={`previous-score score-${scoreTone(score)}`}>
        {displayScore}
      </span>
    </span>
  );
}

function formatScore(score: number | null): string {
  return score === null ? "N/A" : `${score}/10`;
}

function formatAverageScore(score: number | null): string {
  return score === null ? "N/A" : `${score.toFixed(1)}/10`;
}

function formatReviewDate(timestamp: number | null): string {
  if (!timestamp) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatRelativeTime(timestamp: number | null, now: number): string {
  if (!timestamp) {
    return "Just now";
  }

  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return "Just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);

  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return formatReviewDate(timestamp);
}

function formatNextDue(stats: QuestionStats): string {
  if (stats.nextDue === null || stats.msUntilDue === null) {
    return "Unknown";
  }

  if (stats.msUntilDue <= 0) {
    return "Due now";
  }

  return `In ${formatDurationBadge(stats.msUntilDue)}`;
}

function mergeTranscriptText(base: string, addition: string): string {
  const trimmedAddition = addition.trim();

  if (!trimmedAddition) {
    return base;
  }

  if (!base.trim()) {
    return trimmedAddition;
  }

  return /\s$/.test(base) ? `${base}${trimmedAddition}` : `${base} ${trimmedAddition}`;
}

function extractTerminalSpeechCommand(
  baseAnswer: string,
  transcript: string,
): PendingSpeechCommand | null {
  const commandMatch = transcript.match(TERMINAL_SPEECH_COMMAND);

  if (!commandMatch) {
    return null;
  }

  const command = commandMatch[1]?.toLowerCase();

  if (command !== "submit" && command !== "skip") {
    return null;
  }

  const commandStart = commandMatch.index ?? 0;
  const beforeCommand = transcript.slice(0, commandStart);

  return {
    command,
    heldText: transcript.slice(commandStart).trim(),
    submitAnswer: mergeTranscriptText(baseAnswer, beforeCommand),
  };
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const speechWindow = window as Window &
    typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function MicrophoneIcon() {
  return <Mic aria-hidden="true" />;
}

function StopIcon() {
  return <Square aria-hidden="true" fill="currentColor" />;
}

function UploadIcon() {
  return <Upload aria-hidden="true" />;
}

function RemoveIcon() {
  return <Trash2 aria-hidden="true" />;
}

function UserIcon() {
  return <User aria-hidden="true" />;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not read avatar image."));
    };
    reader.onerror = () => reject(new Error("Could not read avatar image."));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read context file."));
    reader.readAsText(file);
  });
}

function createClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTextContextFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();

  return (
    file.type.startsWith("text/") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".tex")
  );
}

function ScoreChart({ entries }: { entries: ReviewHistoryEntry[] }) {
  const width = 520;
  const height = 190;
  const padding = 28;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const points = entries.map((entry, index) => {
    const x =
      entries.length === 1
        ? padding + plotWidth / 2
        : padding + (index / (entries.length - 1)) * plotWidth;
    const y = padding + ((10 - entry.score) / 10) * plotHeight;

    return {
      ...entry,
      x,
      y,
    };
  });
  const path =
    points.length > 1
      ? points
          .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
          .join(" ")
      : "";

  if (entries.length === 0) {
    return (
      <div className="stats-chart-empty">
        Score history will appear after the first graded review.
      </div>
    );
  }

  return (
    <svg
      className="stats-chart"
      role="img"
      aria-label="Previous score history"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding}
        y2={padding}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding + plotHeight / 2}
        y2={padding + plotHeight / 2}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={height - padding}
        y2={height - padding}
      />
      {path ? <path className="stats-chart-line" d={path} /> : null}
      {points.map((point, index) => (
        <g key={`${point.ts}-${index}`}>
          <circle className="stats-chart-point" cx={point.x} cy={point.y} r="5" />
          <text className="stats-chart-label" x={point.x} y={point.y - 10}>
            {point.score}
          </text>
        </g>
      ))}
      <text className="stats-chart-axis" x="8" y={padding + 4}>
        10
      </text>
      <text className="stats-chart-axis" x="14" y={height - padding + 4}>
        0
      </text>
    </svg>
  );
}

function DeckEmbeddingPlot({
  plot,
  reviewQueue,
}: {
  plot: DeckEmbeddingPlotResponse;
  reviewQueue: ReviewQueueItem[];
}) {
  const [hoveredPoint, setHoveredPoint] =
    useState<HoveredEmbeddingPoint | null>(null);
  const plotCanvasRef = useRef<HTMLDivElement | null>(null);
  const width = 720;
  const height = 270;
  const padding = 26;
  const statusByQuestion = useMemo(
    () => new Map(reviewQueue.map((item) => [item.question, item])),
    [reviewQueue],
  );

  function getPointMetadata(
    point: DeckEmbeddingPlotPoint,
  ): Pick<HoveredEmbeddingPoint, "statusLabel" | "scoreLabel"> {
    const queueItem = statusByQuestion.get(point.question);

    return {
      statusLabel: queueItem
        ? queueItem.status === "now"
          ? "Due now"
          : `Due in ${formatDueBadge(queueItem)}`
        : "Not scheduled",
      scoreLabel:
        queueItem?.lastScore === null || queueItem?.lastScore === undefined
          ? null
          : `Last score ${queueItem.lastScore}/10`,
    };
  }

  function showPoint(point: DeckEmbeddingPlotPoint) {
    const x = padding + point.x * (width - padding * 2);
    const y = padding + (1 - point.y) * (height - padding * 2);
    const canvasRect = plotCanvasRef.current?.getBoundingClientRect();
    const canvasWidth = canvasRect?.width ?? width;
    const canvasHeight = canvasRect?.height ?? height;
    const renderedX = (x / width) * canvasWidth;
    const renderedY = (y / height) * canvasHeight;
    const isCompact = canvasWidth < 520;
    const horizontalInset = isCompact ? 10 : 14;
    const arrowInset = 14;
    const tooltipWidth = Math.min(
      isCompact ? 280 : 340,
      canvasWidth - (isCompact ? 20 : 28),
    );
    const minTooltipLeft = horizontalInset;
    const maxTooltipLeft = Math.max(
      minTooltipLeft,
      canvasWidth - tooltipWidth - horizontalInset,
    );
    const tooltipLeft = Math.min(
      Math.max(renderedX - tooltipWidth / 2, minTooltipLeft),
      maxTooltipLeft,
    );
    const metadata = getPointMetadata(point);

    setHoveredPoint({
      ...point,
      ...metadata,
      arrowLeftPx: Math.min(
        Math.max(renderedX - tooltipLeft, arrowInset),
        tooltipWidth - arrowInset,
      ),
      tooltipLeftPx: tooltipLeft,
      tooltipTopPx: renderedY,
      verticalPlacement: y / height < 0.32 ? "below" : "above",
    });
  }

  return (
    <section className="embedding-plot-panel" aria-label="Deck embedding map">
      <div className="embedding-plot-header">
        <div>
          <h2>Embedding map</h2>
          <p>
            {plot.embeddedQuestions}/{plot.totalQuestions} cards
            {plot.model ? ` · ${plot.model}` : ""}
          </p>
        </div>
      </div>

      {plot.points.length === 0 ? (
        <div className="embedding-plot-empty">
          Embeddings will appear here after backfill.
        </div>
      ) : (
        <div
          className="embedding-plot-canvas"
          ref={plotCanvasRef}
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <svg
            className="embedding-plot"
            role="img"
            aria-label="Deck questions plotted by embedding similarity"
            viewBox={`0 0 ${width} ${height}`}
          >
            <line
              className="embedding-plot-grid"
              x1={padding}
              x2={width - padding}
              y1={height / 2}
              y2={height / 2}
            />
            <line
              className="embedding-plot-grid"
              x1={width / 2}
              x2={width / 2}
              y1={padding}
              y2={height - padding}
            />
            <rect
              className="embedding-plot-frame"
              x={padding}
              y={padding}
              width={width - padding * 2}
              height={height - padding * 2}
              rx="10"
            />
            {plot.points.map((point) => {
              const queueItem = statusByQuestion.get(point.question);
              const tone =
                point.lastScore === null
                  ? "unanswered"
                  : queueItem?.status === "now"
                    ? "now"
                    : "scheduled";
              const x = padding + point.x * (width - padding * 2);
              const y = padding + (1 - point.y) * (height - padding * 2);

              return (
                <g
                  className={`embedding-plot-point point-${tone}`}
                  key={point.question}
                  onFocus={() => showPoint(point)}
                  onBlur={() => setHoveredPoint(null)}
                  onMouseEnter={() => showPoint(point)}
                >
                  <circle cx={x} cy={y} r="7" />
                  <circle
                    className="embedding-plot-hit-area"
                    cx={x}
                    cy={y}
                    r="15"
                  />
                </g>
              );
            })}
          </svg>

          {hoveredPoint ? (
            <div
              className={`embedding-tooltip tooltip-y-${hoveredPoint.verticalPlacement}`}
              style={
                {
                  "--tooltip-arrow-left": `${hoveredPoint.arrowLeftPx}px`,
                  left: `${hoveredPoint.tooltipLeftPx}px`,
                  top: `${hoveredPoint.tooltipTopPx}px`,
                } as CSSProperties
              }
              role="status"
            >
              <MarkdownInline
                as="p"
                className="embedding-tooltip-question"
                text={hoveredPoint.question}
              />
              <span className="embedding-tooltip-meta">
                {hoveredPoint.statusLabel}
                {hoveredPoint.scoreLabel ? ` · ${hoveredPoint.scoreLabel}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SubmitIcon() {
  return <ArrowUp aria-hidden="true" />;
}

export default function ReviewApp({
  initialActiveTab = "review",
  initialDeckSlug = null,
  initialDecks = [],
}: ReviewAppProps) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const isLocalAuth = isLocalTestAuthEnabled();
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const cachedSessionRef = useRef(reviewSessionSnapshot);
  const initialRoutedDeckId =
    initialActiveTab === "queue" && initialDeckSlug
      ? initialDecks.find((deck) => deck.slug === initialDeckSlug)?.id ??
        cachedSessionRef.current?.decks.find(
          (deck) => deck.slug === initialDeckSlug,
        )?.id ??
        null
      : null;
  const canUseCachedQueueState =
    !initialRoutedDeckId ||
    cachedSessionRef.current?.selectedDeckDetailId === initialRoutedDeckId;
  const hasLoadedQuestionRef = useRef(
    cachedSessionRef.current?.hasLoadedQuestion ?? false,
  );
  const hasLoadedQueueStatusRef = useRef(
    canUseCachedQueueState
      ? cachedSessionRef.current?.hasLoadedQueueStatus ?? false
      : false,
  );
  const hasLoadedDecksRef = useRef(
    cachedSessionRef.current?.hasLoadedDecks ?? initialDecks.length > 0,
  );
  const loadedQueueSortKeyRef = useRef<QueueSortKey | null>(
    canUseCachedQueueState
      ? cachedSessionRef.current?.loadedQueueSortKey ?? null
      : null,
  );
  const [question, setQuestion] = useState<string | null>(
    () => cachedSessionRef.current?.question ?? null,
  );
  const [learnPanelMode] = useState<LearnPanelMode>("review");
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    () => cachedSessionRef.current?.currentQuestionId ?? null,
  );
  const [currentDeckName, setCurrentDeckName] = useState<string | null>(
    () => cachedSessionRef.current?.currentDeckName ?? null,
  );
  const [currentDeckId, setCurrentDeckId] = useState<string | null>(
    () => cachedSessionRef.current?.currentDeckId ?? null,
  );
  const [answer, setAnswer] = useState(
    () => cachedSessionRef.current?.answer ?? "",
  );
  const [speechPreview, setSpeechPreview] = useState(
    () => cachedSessionRef.current?.speechPreview ?? "",
  );
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const [queueRemaining, setQueueRemaining] = useState(
    () => cachedSessionRef.current?.queueRemaining ?? 0,
  );
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>(
    () => cachedSessionRef.current?.evaluations ?? [],
  );
  const [recentAttempts, setRecentAttempts] = useState<QuestionAttempt[]>(
    () =>
      canUseCachedQueueState
        ? cachedSessionRef.current?.recentAttempts ?? []
        : [],
  );
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>(
    () =>
      canUseCachedQueueState ? cachedSessionRef.current?.reviewQueue ?? [] : [],
  );
  const [reviewQueueTotal, setReviewQueueTotal] = useState(
    () =>
      canUseCachedQueueState
        ? cachedSessionRef.current?.reviewQueueTotal ?? 0
        : 0,
  );
  const [isQueuePageLoading, setIsQueuePageLoading] = useState(
    () =>
      initialActiveTab === "queue" &&
      Boolean(initialRoutedDeckId) &&
      !(
        canUseCachedQueueState &&
        (cachedSessionRef.current?.hasLoadedQueueStatus ?? false)
      ),
  );
  const [queueVirtualRange, setQueueVirtualRange] = useState({
    start: canUseCachedQueueState
      ? cachedSessionRef.current?.queueVirtualRange.start ?? 0
      : 0,
    end: canUseCachedQueueState
      ? cachedSessionRef.current?.queueVirtualRange.end ?? QUEUE_PAGE_SIZE
      : QUEUE_PAGE_SIZE,
  });
  const [queueSortKey, setQueueSortKey] = useState<QueueSortKey>(
    () => cachedSessionRef.current?.queueSortKey ?? "review-date",
  );
  const [decks, setDecks] = useState<DeckManagementItem[]>(
    () => cachedSessionRef.current?.decks ?? initialDecks,
  );
  const [selectedDeckId, setSelectedDeckId] = useState(
    () =>
      cachedSessionRef.current?.selectedDeckId ??
      initialRoutedDeckId ??
      initialDecks[0]?.id ??
      "",
  );
  const [deckSearchQuery, setDeckSearchQuery] = useState(
    () => cachedSessionRef.current?.deckSearchQuery ?? "",
  );
  const [deckSortKey, setDeckSortKey] = useState<DeckSortKey>(
    () => cachedSessionRef.current?.deckSortKey ?? "updated",
  );
  const [selectedDeckDetailId, setSelectedDeckDetailId] = useState<
    string | null
  >(() =>
    initialActiveTab === "queue" && initialDeckSlug
      ? initialRoutedDeckId ?? cachedSessionRef.current?.selectedDeckDetailId ?? null
      : null,
  );
  const [isCreatingDeck, setIsCreatingDeck] = useState(
    () => cachedSessionRef.current?.isCreatingDeck ?? false,
  );
  const [editingDeckId, setEditingDeckId] = useState<string | null>(
    () => cachedSessionRef.current?.editingDeckId ?? null,
  );
  const [deckDraftName, setDeckDraftName] = useState(
    () => cachedSessionRef.current?.deckDraftName ?? "",
  );
  const [deckDraftCoverage, setDeckDraftCoverage] = useState(
    () => cachedSessionRef.current?.deckDraftCoverage ?? "",
  );
  const [isDecksLoading, setIsDecksLoading] = useState(false);
  const [isDeckSaving, setIsDeckSaving] = useState(false);
  const [isDeckDeleting, setIsDeckDeleting] = useState(false);
  const [deckPageMessage, setDeckPageMessage] = useState<string | null>(null);
  const [deckEditorMessage, setDeckEditorMessage] = useState<string | null>(null);
  const [deckEmbeddingPlot, setDeckEmbeddingPlot] =
    useState<DeckEmbeddingPlotResponse>(
      () =>
        canUseCachedQueueState
          ? cachedSessionRef.current?.deckEmbeddingPlot ??
            createEmptyDeckEmbeddingPlot()
          : createEmptyDeckEmbeddingPlot(),
    );
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => cachedSessionRef.current?.messages ?? [],
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialActiveTab);
  const [routeDeckSlug, setRouteDeckSlug] = useState<string | null>(
    initialActiveTab === "queue" ? initialDeckSlug : null,
  );
  const [referenceAnswers, setReferenceAnswers] = useState<
    Record<string, ReferenceAnswerState>
  >(() => cachedSessionRef.current?.referenceAnswers ?? {});
  const [isPreviousExpanded, setIsPreviousExpanded] = useState(
    () => cachedSessionRef.current?.isPreviousExpanded ?? false,
  );
  const [expandedPreviousAnswerIds, setExpandedPreviousAnswerIds] = useState<
    Set<string>
  >(() => new Set(cachedSessionRef.current?.expandedPreviousAnswerIds ?? []));
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(
    () => cachedSessionRef.current?.selectedQuestionId ?? null,
  );
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(
    () => cachedSessionRef.current?.selectedQuestion ?? null,
  );
  const [isLoadingQuestion, setIsLoadingQuestion] = useState(
    () => !hasLoadedQuestionRef.current,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isQuestionGeneratorOpen, setIsQuestionGeneratorOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfileResponse | null>(
    () => cachedSessionRef.current?.currentUser ?? null,
  );
  const [isAvatarUpdating, setIsAvatarUpdating] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const canViewAdmin = isAdminEmail(currentUser?.email);
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";
  const [generatorScope, setGeneratorScope] = useState(
    () => cachedSessionRef.current?.generatorScope ?? "",
  );
  const [generatorQuestionCount, setGeneratorQuestionCount] = useState(
    () =>
      cachedSessionRef.current?.generatorQuestionCount ??
      DEFAULT_GENERATED_QUESTION_COUNT,
  );
  const [generatorFiles, setGeneratorFiles] = useState<GeneratorContextFile[]>(
    () => cachedSessionRef.current?.generatorFiles ?? [],
  );
  const [generatedQuestions, setGeneratedQuestions] = useState<
    GeneratedQuestionCandidate[]
  >(() => cachedSessionRef.current?.generatedQuestions ?? []);
  const [generatorMessage, setGeneratorMessage] = useState<string | null>(
    () => cachedSessionRef.current?.generatorMessage ?? null,
  );
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [isLearnTopUpPending, setIsLearnTopUpPending] = useState(false);
  const [learnTopUpMessage, setLearnTopUpMessage] = useState<string | null>(null);
  const [learnGenerationStatus, setLearnGenerationStatus] = useState<string | null>(
    null,
  );
  const [learnGenerationProgress, setLearnGenerationProgress] =
    useState<LearnGenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [reviewQueueVersion, setReviewQueueVersion] = useState(0);
  const answerRef = useRef(answer);
  const questionRef = useRef(question);
  const questionIdRef = useRef(currentQuestionId);
  const pendingLearnSourceRef = useRef<{
    deckId: string | null;
    question: string | null;
  } | null>(null);
  const learnTopUpSatisfiedKeyRef = useRef<string | null>(null);
  const learnTargetDeckIdRef = useRef<string | null>(
    cachedSessionRef.current?.selectedDeckDetailId ??
      cachedSessionRef.current?.selectedDeckId ??
      null,
  );
  const topUpLearnQueueRef = useRef<(() => Promise<void>) | null>(null);
  const queueStageRef = useRef<HTMLElement | null>(null);
  const queueListRef = useRef<HTMLOListElement | null>(null);
  const queueLoadedLimitRef = useRef(
    canUseCachedQueueState
      ? cachedSessionRef.current?.queueLoadedLimit ?? QUEUE_PAGE_SIZE
      : QUEUE_PAGE_SIZE,
  );
  const loadedDeckEmbeddingPlotKeyRef = useRef<string | null>(null);
  const isQueuePageLoadingRef = useRef(false);
  const answerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const isSubmittingRef = useRef(isSubmitting);
  const submitSequenceRef = useRef(0);
  const shouldRefocusAnswerAfterSubmitRef = useRef(false);
  const keepListeningRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const pendingSpeechCommandRef = useRef<PendingSpeechCommand | null>(null);
  const pendingSpeechCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prefetchedNextQuestionRef = useRef<PrefetchedNextQuestion | null>(null);
  const nextQuestionPrefetchRef = useRef<NextQuestionPrefetch | null>(null);
  const isLearnTopUpPendingRef = useRef(false);
  const learnTopUpCooldownUntilRef = useRef(0);

  const togglePreviousAnswerDetails = useCallback((id: string) => {
    setExpandedPreviousAnswerIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (nextIds.has(id)) {
        nextIds.delete(id);
      } else {
        nextIds.add(id);
      }

      return nextIds;
    });
  }, []);

  const navigateToTab = useCallback(
    (
      nextTab: ActiveTab,
      event?: ReactMouseEvent<HTMLAnchorElement>,
      deckSlug?: string | null,
    ) => {
      event?.preventDefault();
      setActiveTab(nextTab);
      setRouteDeckSlug(nextTab === "queue" ? deckSlug ?? null : null);

      const nextPath =
        nextTab === "queue" ? deckPath(deckSlug) : REVIEW_TAB_PATHS[nextTab];

      if (window.location.pathname !== nextPath) {
        window.history.pushState(
          {
            activeTab: nextTab,
            deckSlug: nextTab === "queue" ? deckSlug ?? null : null,
          },
          "",
          nextPath,
        );
      }
    },
    [],
  );

  const openQueue = useCallback(() => {
    navigateToTab("queue");
  }, [navigateToTab]);

  useEffect(() => {
    setActiveTab(initialActiveTab);
    setRouteDeckSlug(initialActiveTab === "queue" ? initialDeckSlug : null);

    if (initialActiveTab !== "queue" || !initialDeckSlug) {
      setSelectedDeckDetailId(null);
    }
  }, [initialActiveTab, initialDeckSlug]);

  useEffect(() => {
    function syncTabFromHistory() {
      const nextRoute = getReviewRouteStateFromPathname(window.location.pathname);

      if (nextRoute) {
        setActiveTab(nextRoute.activeTab);
        setRouteDeckSlug(nextRoute.deckSlug);
        return;
      }

      window.location.reload();
    }

    window.addEventListener("popstate", syncTabFromHistory);

    return () => window.removeEventListener("popstate", syncTabFromHistory);
  }, []);

  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    questionIdRef.current = currentQuestionId;
  }, [currentQuestionId]);

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  useEffect(() => {
    isLearnTopUpPendingRef.current = isLearnTopUpPending;
  }, [isLearnTopUpPending]);

  useEffect(() => {
    isQueuePageLoadingRef.current = isQueuePageLoading;
  }, [isQueuePageLoading]);

  useEffect(() => {
    if (!shouldRefocusAnswerAfterSubmitRef.current) {
      return;
    }

    if (activeTab !== "review" || (!isSubmitting && !question)) {
      shouldRefocusAnswerAfterSubmitRef.current = false;
      return;
    }

    if (isSubmitting || !question) {
      return;
    }

    shouldRefocusAnswerAfterSubmitRef.current = false;
    const frameId = window.requestAnimationFrame(() => {
      answerInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeTab, isSubmitting, question]);

  useEffect(() => {
    reviewSessionSnapshot = {
      learnPanelMode,
      currentQuestionId,
      question,
      currentDeckId,
      currentDeckName,
      answer,
      speechPreview,
      queueRemaining,
      evaluations,
      recentAttempts,
      reviewQueue,
      reviewQueueTotal,
      queueVirtualRange,
      queueSortKey,
      decks,
      selectedDeckId,
      deckSearchQuery,
      deckSortKey,
      selectedDeckDetailId,
      isCreatingDeck,
      editingDeckId,
      deckDraftName,
      deckDraftCoverage,
      deckEmbeddingPlot,
      messages,
      referenceAnswers,
      isPreviousExpanded,
      expandedPreviousAnswerIds: new Set(expandedPreviousAnswerIds),
      selectedQuestionId,
      selectedQuestion,
      currentUser,
      generatorScope,
      generatorQuestionCount,
      generatorFiles,
      generatedQuestions,
      generatorMessage,
      hasLoadedQuestion: hasLoadedQuestionRef.current,
      hasLoadedQueueStatus: hasLoadedQueueStatusRef.current,
      hasLoadedDecks: hasLoadedDecksRef.current,
      loadedQueueSortKey: loadedQueueSortKeyRef.current,
      queueLoadedLimit: queueLoadedLimitRef.current,
    };
  }, [
    answer,
    currentQuestionId,
    currentDeckId,
    currentDeckName,
    currentUser,
    deckDraftCoverage,
    deckDraftName,
    deckEmbeddingPlot,
    deckSearchQuery,
    deckSortKey,
    decks,
    editingDeckId,
    evaluations,
    expandedPreviousAnswerIds,
    isCreatingDeck,
    learnPanelMode,
    generatedQuestions,
    generatorFiles,
    generatorMessage,
    generatorQuestionCount,
    generatorScope,
    isPreviousExpanded,
    messages,
    question,
    queueRemaining,
    queueSortKey,
    queueVirtualRange,
    recentAttempts,
    referenceAnswers,
    reviewQueue,
    reviewQueueTotal,
    selectedDeckId,
    selectedDeckDetailId,
    selectedQuestionId,
    selectedQuestion,
    speechPreview,
  ]);

  const selectQuestion = useCallback(
    (nextQuestion: string | null, nextQuestionId: string | null = null) => {
      setSelectedQuestion(nextQuestion);
      setSelectedQuestionId(nextQuestion ? nextQuestionId : null);
    },
    [],
  );

  const closeQuestionGenerator = useCallback(() => {
    if (isGeneratingQuestions) {
      return;
    }

    setIsQuestionGeneratorOpen(false);
    setGeneratedQuestions([]);
    setGeneratorMessage(null);
  }, [isGeneratingQuestions]);

  const openQuestionGenerator = useCallback(() => {
    setGeneratedQuestions([]);
    setGeneratorMessage(null);
    setIsQuestionGeneratorOpen(true);
  }, []);

  const rememberLearnTargetDeck = useCallback((deckId: string | null) => {
    learnTargetDeckIdRef.current = deckId;
    storeLearnTargetDeckId(deckId);
  }, []);

  useEffect(() => {
    if (learnTargetDeckIdRef.current) {
      return;
    }

    learnTargetDeckIdRef.current = getStoredLearnTargetDeckId();
  }, []);

  const selectedDeck =
    decks.find((deck) => deck.id === selectedDeckId) ?? decks[0] ?? null;
  const selectedDeckDetail =
    decks.find((deck) => deck.id === selectedDeckDetailId) ?? null;
  const editingDeck =
    decks.find((deck) => deck.id === editingDeckId) ?? null;
  const deckDraftNameKey = normalizeDeckNameForComparison(deckDraftName);
  const isDeckDraftNameDuplicate =
    deckDraftNameKey.length > 0 &&
    decks.some(
      (deck) =>
        deck.id !== editingDeckId &&
        normalizeDeckNameForComparison(deck.name) === deckDraftNameKey,
    );
  const deckDraftNameMessage = isDeckDraftNameDuplicate
    ? "Deck name already exists."
    : deckEditorMessage;
  const isDeckEditorBusy = isDeckSaving || isDeckDeleting;
  const canSaveDeckDraft =
    !isDeckEditorBusy && deckDraftNameKey.length > 0 && !isDeckDraftNameDuplicate;
  const visibleDecks = useMemo(() => {
    const normalizedQuery = deckSearchQuery.trim().toLowerCase();
    const filteredDecks = normalizedQuery
      ? decks.filter((deck) =>
          `${deck.name} ${deck.slug}`.toLowerCase().includes(normalizedQuery),
        )
      : decks;

    return [...filteredDecks].sort((a, b) => {
      if (deckSortKey === "name") {
        return a.name.localeCompare(b.name);
      }

      if (deckSortKey === "due") {
        return b.dueCount - a.dueCount || a.name.localeCompare(b.name);
      }

      return (
        Number(b.inReviewRotation) - Number(a.inReviewRotation) ||
        b.dueCount - a.dueCount ||
        a.name.localeCompare(b.name)
      );
    });
  }, [deckSearchQuery, deckSortKey, decks]);
  const rotationDeckCount = decks.filter((deck) => deck.inReviewRotation).length;
  const rotationDueCount = decks.reduce(
    (total, deck) => (deck.inReviewRotation ? total + deck.dueCount : total),
    0,
  );
  const totalCardCount = decks.reduce((total, deck) => total + deck.cardCount, 0);

  const loadDecks = useCallback(async () => {
    setIsDecksLoading(true);
    setDeckPageMessage(null);

    try {
      const response = await fetch("/api/decks", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Could not load decks.");
      }

      const data = (await response.json()) as DecksResponse;

      setDecks(data.decks);
      setSelectedDeckId((currentDeckId) =>
        data.decks.some((deck) => deck.id === currentDeckId)
          ? currentDeckId
          : data.decks[0]?.id ?? "",
      );
    } catch (loadError) {
      setDeckPageMessage(
        loadError instanceof Error ? loadError.message : "Could not load decks.",
      );
    } finally {
      hasLoadedDecksRef.current = true;
      setIsDecksLoading(false);
    }
  }, []);

  const openDeckEditor = useCallback((deck: DeckManagementItem) => {
    setSelectedDeckId(deck.id);
    setDeckDraftName(deck.name);
    setDeckDraftCoverage(deck.coverage ?? "");
    setDeckEditorMessage(null);
    setIsCreatingDeck(false);
    setEditingDeckId(deck.id);
  }, []);

  const createDeck = useCallback(() => {
    setDeckPageMessage(null);
    setDeckEditorMessage(null);
    setDeckDraftName("");
    setDeckDraftCoverage("");
    setEditingDeckId(null);
    setIsCreatingDeck(true);
  }, []);

  const saveDeckDraft = useCallback(async () => {
    if ((!editingDeckId && !isCreatingDeck) || isDeckSaving) {
      return;
    }

    const nextName = deckDraftName.trim();

    if (!nextName) {
      setDeckEditorMessage("Deck name is required.");
      return;
    }

    if (isDeckDraftNameDuplicate) {
      setDeckEditorMessage("Deck name already exists.");
      return;
    }

    setDeckEditorMessage(null);
    setDeckPageMessage(null);
    setIsDeckSaving(true);

    try {
      const response = await fetch(
        isCreatingDeck
          ? "/api/decks"
          : `/api/decks/${encodeURIComponent(editingDeckId as string)}`,
        {
          method: isCreatingDeck ? "POST" : "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: nextName,
            coverage: deckDraftCoverage,
            ...(isCreatingDeck ? { inReviewRotation: true } : {}),
          }),
        },
      );
      const data = (await response.json()) as DeckMutationResponse;

      if (!response.ok || !data.ok || !data.deck) {
        throw new Error(
          data.error ??
            (isCreatingDeck ? "Could not create deck." : "Could not update deck."),
        );
      }

      const savedDeck = data.deck as DeckManagementItem;

      if (isCreatingDeck) {
        setDecks((currentDecks) => [
          savedDeck,
          ...currentDecks,
        ]);
        setSelectedDeckId(savedDeck.id);
        rememberLearnTargetDeck(savedDeck.id);
      } else {
        setDecks((currentDecks) =>
          currentDecks.map((deck) =>
            deck.id === editingDeckId ? savedDeck : deck,
          ),
        );

        if (selectedDeckDetailId === savedDeck.id) {
          setRouteDeckSlug(savedDeck.slug);
          navigateToTab("queue", undefined, savedDeck.slug);
        }
      }

      setIsCreatingDeck(false);
      setEditingDeckId(null);
    } catch (updateError) {
      setDeckEditorMessage(
        updateError instanceof Error
          ? updateError.message
          : isCreatingDeck
            ? "Could not create deck."
            : "Could not update deck.",
      );
    } finally {
      setIsDeckSaving(false);
    }
  }, [
    deckDraftName,
    deckDraftCoverage,
    editingDeckId,
    isCreatingDeck,
    isDeckDraftNameDuplicate,
    isDeckSaving,
    navigateToTab,
    rememberLearnTargetDeck,
    selectedDeckDetailId,
  ]);

  const toggleDeckRotation = useCallback(async (deck: DeckManagementItem) => {
    setDeckPageMessage(null);

    try {
      const response = await fetch(`/api/decks/${encodeURIComponent(deck.id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inReviewRotation: !deck.inReviewRotation,
        }),
      });
      const data = (await response.json()) as DeckMutationResponse;

      if (!response.ok || !data.ok || !data.deck) {
        throw new Error(data.error ?? "Could not update rotation.");
      }

      setDecks((currentDecks) =>
        currentDecks.map((currentDeck) =>
          currentDeck.id === deck.id ? (data.deck as DeckManagementItem) : currentDeck,
        ),
      );
      prefetchedNextQuestionRef.current = null;
      nextQuestionPrefetchRef.current?.abortController.abort();
      nextQuestionPrefetchRef.current = null;
      hasLoadedQuestionRef.current = false;
      setQuestion(null);
      questionRef.current = null;
      setCurrentQuestionId(null);
      questionIdRef.current = null;
      setCurrentDeckId(null);
      setQueueRemaining(0);
      setReviewQueueVersion((currentVersion) => currentVersion + 1);
    } catch (toggleError) {
      setDeckPageMessage(
        toggleError instanceof Error
          ? toggleError.message
          : "Could not update rotation.",
      );
    }
  }, []);

  const resetDeckQueueState = useCallback(() => {
    queueLoadedLimitRef.current = QUEUE_PAGE_SIZE;
    loadedDeckEmbeddingPlotKeyRef.current = null;
    hasLoadedQueueStatusRef.current = false;
    loadedQueueSortKeyRef.current = null;
    setReviewQueue([]);
    setRecentAttempts([]);
    setReviewQueueTotal(0);
    setDeckEmbeddingPlot(createEmptyDeckEmbeddingPlot());
    setQueueVirtualRange({
      start: 0,
      end: QUEUE_PAGE_SIZE,
    });
  }, []);

  const openDeckQueue = useCallback(
    (deck: DeckManagementItem, options: { updateUrl?: boolean } = {}) => {
      const shouldReset = selectedDeckDetailId !== deck.id;

      setSelectedDeckId(deck.id);
      setSelectedDeckDetailId(deck.id);
      setRouteDeckSlug(deck.slug);
      rememberLearnTargetDeck(deck.id);

      if (shouldReset) {
        resetDeckQueueState();
      }

      if (options.updateUrl ?? true) {
        navigateToTab("queue", undefined, deck.slug);
      } else {
        setActiveTab("queue");
      }
    },
    [navigateToTab, rememberLearnTargetDeck, resetDeckQueueState, selectedDeckDetailId],
  );

  const closeDeckQueue = useCallback(() => {
    setSelectedDeckDetailId(null);
    setRouteDeckSlug(null);
    resetDeckQueueState();
    navigateToTab("queue");
  }, [navigateToTab, resetDeckQueueState]);

  const deleteEditingDeck = useCallback(async () => {
    if (!editingDeck || isCreatingDeck || isDeckDeleting) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete "${editingDeck.name}" and all of its questions, answers, review history, and embeddings? This cannot be undone.`,
    );

    if (!shouldDelete) {
      return;
    }

    const deckId = editingDeck.id;
    const deckName = editingDeck.name;
    const nextDecks = decks.filter((deck) => deck.id !== deckId);
    const wasOpenDeck = selectedDeckDetailId === deckId;
    const wasCurrentQuestionDeck = currentDeckId === deckId;

    setDeckEditorMessage(null);
    setDeckPageMessage(null);
    setIsDeckDeleting(true);

    try {
      const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as DeckMutationResponse;

      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "Could not delete deck.");
      }

      setDecks(nextDecks);
      setSelectedDeckId((currentDeckIdValue) =>
        currentDeckIdValue === deckId
          ? nextDecks[0]?.id ?? ""
          : currentDeckIdValue,
      );
      rememberLearnTargetDeck(null);
      setEvaluations((currentEvaluations) =>
        currentEvaluations.filter((evaluation) => evaluation.deckId !== deckId),
      );
      setMessages((currentMessages) =>
        currentMessages.filter(
          (message) => message.kind !== "answer" || message.deckId !== deckId,
        ),
      );

      if (wasCurrentQuestionDeck) {
        prefetchedNextQuestionRef.current = null;
        nextQuestionPrefetchRef.current?.abortController.abort();
        nextQuestionPrefetchRef.current = null;
        hasLoadedQuestionRef.current = false;
        setQuestion(null);
        questionRef.current = null;
        setCurrentQuestionId(null);
        questionIdRef.current = null;
        setCurrentDeckId(null);
        setCurrentDeckName(null);
        setAnswer("");
        setSpeechPreview("");
        setMessages([]);
        setQueueRemaining(0);
      }

      if (wasOpenDeck) {
        setSelectedDeckDetailId(null);
        setRouteDeckSlug(null);
        resetDeckQueueState();
        navigateToTab("queue");
      }

      setSelectedQuestionId(null);
      setSelectedQuestion(null);
      setIsCreatingDeck(false);
      setEditingDeckId(null);
      setReviewQueueVersion((currentVersion) => currentVersion + 1);
      setDeckPageMessage(`Deleted ${deckName}.`);
    } catch (deleteError) {
      setDeckEditorMessage(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete deck.",
      );
    } finally {
      setIsDeckDeleting(false);
    }
  }, [
    currentDeckId,
    decks,
    editingDeck,
    isCreatingDeck,
    isDeckDeleting,
    navigateToTab,
    rememberLearnTargetDeck,
    resetDeckQueueState,
    selectedDeckDetailId,
  ]);

  const hasPendingEvaluationActivity =
    evaluations.some((evaluation) => evaluation.status === "grading") ||
    messages.some(
      (message) => message.kind === "answer" && message.status === "grading",
    );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, hasPendingEvaluationActivity ? 1_000 : 60_000);

    return () => window.clearInterval(interval);
  }, [hasPendingEvaluationActivity]);

  useEffect(() => {
    if (activeTab !== "queue" || hasLoadedDecksRef.current || isDecksLoading) {
      return;
    }

    void loadDecks();
  }, [activeTab, isDecksLoading, loadDecks]);

  useEffect(() => {
    if (activeTab !== "queue") {
      return;
    }

    if (!routeDeckSlug) {
      if (selectedDeckDetailId) {
        setSelectedDeckDetailId(null);
        resetDeckQueueState();
      }

      return;
    }

    const routedDeck = decks.find((deck) => deck.slug === routeDeckSlug);

    if (routedDeck) {
      setDeckPageMessage(null);
      openDeckQueue(routedDeck, { updateUrl: false });
      return;
    }

    if (hasLoadedDecksRef.current && !isDecksLoading) {
      setSelectedDeckDetailId(null);
      setDeckPageMessage(`Deck "${routeDeckSlug}" was not found.`);
    }
  }, [
    activeTab,
    decks,
    isDecksLoading,
    openDeckQueue,
    resetDeckQueueState,
    routeDeckSlug,
    selectedDeckDetailId,
  ]);

  useEffect(() => {
    if (cachedSessionRef.current?.currentUser) {
      return;
    }

    let isActive = true;

    async function loadUserProfile() {
      try {
        const response = await fetch("/api/user", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error("Could not load profile.");
        }

        const data = (await response.json()) as UserProfileResponse;

        if (isActive) {
          setCurrentUser(data);
        }
      } catch {
        if (isActive) {
          setAvatarMessage("Could not load profile.");
        }
      }
    }

    void loadUserProfile();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    function closeSettingsOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    }

    window.addEventListener("keydown", closeSettingsOnEscape);

    return () => window.removeEventListener("keydown", closeSettingsOnEscape);
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isQuestionGeneratorOpen) {
      return;
    }

    function closeGeneratorOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        if (isGeneratingQuestions) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        closeQuestionGenerator();
      }
    }

    window.addEventListener("keydown", closeGeneratorOnEscape);

    return () => window.removeEventListener("keydown", closeGeneratorOnEscape);
  }, [closeQuestionGenerator, isGeneratingQuestions, isQuestionGeneratorOpen]);

  const clearPendingSpeechCommand = useCallback(() => {
    if (pendingSpeechCommandTimerRef.current) {
      clearTimeout(pendingSpeechCommandTimerRef.current);
      pendingSpeechCommandTimerRef.current = null;
    }

    pendingSpeechCommandRef.current = null;
  }, []);

  const appendAnswerText = useCallback((text: string) => {
    setAnswer((current) => {
      const nextAnswer = mergeTranscriptText(current, text);
      answerRef.current = nextAnswer;
      return nextAnswer;
    });
  }, []);

  const appendQuestion = useCallback((nextQuestion: string) => {
    setMessages((current) => {
      const last = current.at(-1);

      if (last?.kind === "question" && last.question === nextQuestion) {
        return current;
      }

      return [
        ...current,
        {
          id: `question-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: "question",
          question: nextQuestion,
        },
      ];
    });
  }, []);

  const applyNextQuestion = useCallback((
    data: NextQuestionResponse,
    options?: { appendToMessages?: boolean },
  ) => {
    hasLoadedQuestionRef.current = true;
    setCurrentQuestionId(data.questionId);
    questionIdRef.current = data.questionId;
    setQuestion(data.question);
    questionRef.current = data.question;
    setCurrentDeckId(data.deckId);
    setCurrentDeckName(data.deckName);
    setQueueRemaining(data.queueRemaining);

    if (data.question && options?.appendToMessages !== false) {
      appendQuestion(data.question);
    }
  }, [appendQuestion]);

  const getNextQuestionDeckId = useCallback(
    (mode: LearnPanelMode) =>
      mode === "learn"
        ? selectedDeckDetailId ||
          learnTargetDeckIdRef.current ||
          (questionRef.current ? currentDeckId : selectedDeckId) ||
          currentDeckId ||
          selectedDeckId ||
          null
        : null,
    [currentDeckId, selectedDeckDetailId, selectedDeckId],
  );

  const prefetchNextQuestion = useCallback((
    mode: LearnPanelMode,
    excludeQuestionId: string | null,
    excludeQuestion: string | null,
  ) => {
    const deckId = getNextQuestionDeckId(mode);
    const normalizedQuestionId = excludeQuestionId?.trim() || null;
    const normalizedQuestion = excludeQuestion?.trim();

    if (!normalizedQuestion) {
      return;
    }

    if (
      prefetchedNextQuestionRef.current?.mode === mode &&
      prefetchedNextQuestionRef.current?.deckId === deckId &&
      prefetchedNextQuestionRef.current?.excludeQuestionId ===
        normalizedQuestionId &&
      prefetchedNextQuestionRef.current?.excludeQuestion === normalizedQuestion
    ) {
      return;
    }

    if (
      nextQuestionPrefetchRef.current?.mode === mode &&
      nextQuestionPrefetchRef.current?.deckId === deckId &&
      nextQuestionPrefetchRef.current?.excludeQuestionId ===
        normalizedQuestionId &&
      nextQuestionPrefetchRef.current?.excludeQuestion === normalizedQuestion
    ) {
      return;
    }

    prefetchedNextQuestionRef.current = null;
    nextQuestionPrefetchRef.current?.abortController.abort();

    const abortController = new AbortController();
    const promise = fetchNextQuestionData({
      mode,
      deckId,
      excludeQuestionId: normalizedQuestionId,
      excludeQuestion: normalizedQuestion,
      signal: abortController.signal,
    })
      .then((data): PrefetchedNextQuestion => ({
        mode,
        deckId,
        excludeQuestionId: normalizedQuestionId,
        excludeQuestion: normalizedQuestion,
        data,
      }))
      .catch((prefetchError): null => {
        if (
          prefetchError instanceof DOMException &&
          prefetchError.name === "AbortError"
        ) {
          return null;
        }

        return null;
      });

    const request: NextQuestionPrefetch = {
      mode,
      deckId,
      excludeQuestionId: normalizedQuestionId,
      excludeQuestion: normalizedQuestion,
      abortController,
      promise,
    };

    nextQuestionPrefetchRef.current = request;

    void promise.then((prefetched) => {
      if (nextQuestionPrefetchRef.current !== request) {
        return;
      }

      nextQuestionPrefetchRef.current = null;

      if (
        prefetched &&
        questionIdRef.current === prefetched.excludeQuestionId &&
        questionRef.current === prefetched.excludeQuestion
      ) {
        prefetchedNextQuestionRef.current = prefetched;
      }
    });
  }, [getNextQuestionDeckId]);

  const takePrefetchedNextQuestion = useCallback(
    async (
      mode: LearnPanelMode,
      excludeQuestionId: string | null,
      excludeQuestion: string,
    ) => {
      const deckId = getNextQuestionDeckId(mode);
      const normalizedQuestionId = excludeQuestionId?.trim() || null;
      const normalizedQuestion = excludeQuestion.trim();
      const cachedQuestion = prefetchedNextQuestionRef.current;

      if (
        cachedQuestion?.mode === mode &&
        cachedQuestion?.deckId === deckId &&
        cachedQuestion?.excludeQuestionId === normalizedQuestionId &&
        cachedQuestion?.excludeQuestion === normalizedQuestion
      ) {
        prefetchedNextQuestionRef.current = null;
        return cachedQuestion.data;
      }

      const pendingPrefetch = nextQuestionPrefetchRef.current;

      if (
        pendingPrefetch?.mode !== mode ||
        pendingPrefetch.deckId !== deckId ||
        pendingPrefetch?.excludeQuestionId !== normalizedQuestionId ||
        pendingPrefetch?.excludeQuestion !== normalizedQuestion
      ) {
        return null;
      }

      const prefetched = await pendingPrefetch.promise;

      if (nextQuestionPrefetchRef.current === pendingPrefetch) {
        nextQuestionPrefetchRef.current = null;
      }

      if (
        prefetched?.mode !== mode ||
        prefetched.deckId !== deckId ||
        prefetched.excludeQuestionId !== normalizedQuestionId ||
        prefetched.excludeQuestion !== normalizedQuestion
      ) {
        return null;
      }

      prefetchedNextQuestionRef.current = null;
      return prefetched.data;
    },
    [getNextQuestionDeckId],
  );

  const loadNextQuestion = useCallback(async (options?: {
    mode?: LearnPanelMode;
    excludeQuestionId?: string | null;
    excludeQuestion?: string | null;
    surfaceError?: boolean;
  }) => {
    const surfaceError = options?.surfaceError ?? true;
    const mode = options?.mode ?? learnPanelMode;

    setIsLoadingQuestion(true);
    if (mode === "learn") {
      setLearnGenerationStatus("Checking for an available question");
    }
    setQuestion(null);
    questionRef.current = null;
    setCurrentQuestionId(null);
    questionIdRef.current = null;
    setCurrentDeckId(null);
    setCurrentDeckName(null);
    setError(null);

    try {
      const data = await fetchNextQuestionData({
        mode,
        deckId: getNextQuestionDeckId(mode),
        excludeQuestionId: options?.excludeQuestionId,
        excludeQuestion: options?.excludeQuestion,
      });
      applyNextQuestion(data);
      hasLoadedQuestionRef.current = true;
      return data;
    } catch (loadError) {
      if (surfaceError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load the next question.",
        );
      }
      return null;
    } finally {
      setIsLoadingQuestion(false);
    }
  }, [applyNextQuestion, getNextQuestionDeckId, learnPanelMode]);

  const queueStatusUrl = useCallback((limit: number) => {
    const params = new URLSearchParams({
      limit: String(Math.max(0, Math.floor(limit))),
      offset: "0",
      sort: queueSortKey,
      includeDeckEmbeddingPlot: "0",
    });

    if (selectedDeckDetailId) {
      params.set("deckId", selectedDeckDetailId);
    }

    return `/api/queue-status?${params.toString()}`;
  }, [queueSortKey, selectedDeckDetailId]);

  const queueStatusStreamUrl = useCallback((limit: number) => {
    const params = new URLSearchParams({
      limit: String(Math.max(0, Math.floor(limit))),
      offset: "0",
      sort: queueSortKey,
      includeDeckEmbeddingPlot: "0",
    });

    if (selectedDeckDetailId) {
      params.set("deckId", selectedDeckDetailId);
    }

    return `/api/queue-status/stream?${params.toString()}`;
  }, [queueSortKey, selectedDeckDetailId]);

  const deckEmbeddingPlotUrl = useCallback((limit: number) => {
    const params = new URLSearchParams({
      limit: String(Math.max(0, Math.floor(limit))),
      offset: "0",
      sort: queueSortKey,
    });

    if (selectedDeckDetailId) {
      params.set("deckId", selectedDeckDetailId);
    }

    return `/api/deck-embedding-plot?${params.toString()}`;
  }, [queueSortKey, selectedDeckDetailId]);

  const applyQueueStatus = useCallback((data: QueueStatusResponse) => {
    setQueueRemaining(data.queueRemaining);
    setEvaluations(data.evaluations);
    setRecentAttempts(data.recentAttempts ?? []);
    setReviewQueue(data.reviewQueue);
    setReviewQueueTotal(data.reviewQueueTotal ?? data.reviewQueue.length);
    queueLoadedLimitRef.current = Math.max(
      QUEUE_PAGE_SIZE,
      data.reviewQueueLimit ?? data.reviewQueue.length,
    );
    hasLoadedQueueStatusRef.current = true;
    loadedQueueSortKeyRef.current = queueSortKey;
    if (
      data.deckEmbeddingPlot &&
      (data.deckEmbeddingPlot.model ||
        data.deckEmbeddingPlot.totalQuestions > 0 ||
        data.deckEmbeddingPlot.embeddedQuestions > 0 ||
        data.deckEmbeddingPlot.points.length > 0)
    ) {
      setDeckEmbeddingPlot(data.deckEmbeddingPlot);
    }
  }, [queueSortKey]);

  const loadStatus = useCallback(async (limit = QUEUE_PAGE_SIZE) => {
    if (isQueuePageLoadingRef.current) {
      return;
    }

    isQueuePageLoadingRef.current = true;
    setIsQueuePageLoading(true);

    try {
      const response = await fetch(queueStatusUrl(limit), {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as QueueStatusResponse;
      applyQueueStatus(data);
    } catch {
      // Status is informational; keep the review loop usable if polling fails.
    } finally {
      isQueuePageLoadingRef.current = false;
      setIsQueuePageLoading(false);
    }
  }, [applyQueueStatus, queueStatusUrl]);

  const loadDeckEmbeddingPlot = useCallback(async (limit = QUEUE_PAGE_SIZE) => {
    if (!selectedDeckDetailId) {
      return;
    }

    const normalizedLimit = Math.max(QUEUE_PAGE_SIZE, Math.floor(limit));
    const plotKey = `${selectedDeckDetailId}:${queueSortKey}:${normalizedLimit}`;

    if (loadedDeckEmbeddingPlotKeyRef.current === plotKey) {
      return;
    }

    try {
      const response = await fetch(deckEmbeddingPlotUrl(normalizedLimit), {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as DeckEmbeddingPlotResponse;

      loadedDeckEmbeddingPlotKeyRef.current = plotKey;
      setDeckEmbeddingPlot(data);
    } catch {
      // The queue remains usable without the optional embedding map.
    }
  }, [deckEmbeddingPlotUrl, queueSortKey, selectedDeckDetailId]);

  useEffect(() => {
    if (activeTab !== "review") {
      return;
    }

    if (hasLoadedQuestionRef.current) {
      return;
    }

    void loadNextQuestion({ surfaceError: false });
  }, [activeTab, loadNextQuestion, reviewQueueVersion]);

  useEffect(() => {
    if (!question) {
      prefetchedNextQuestionRef.current = null;
      nextQuestionPrefetchRef.current?.abortController.abort();
      nextQuestionPrefetchRef.current = null;
      return;
    }

    prefetchNextQuestion(learnPanelMode, currentQuestionId, question);
  }, [currentQuestionId, learnPanelMode, prefetchNextQuestion, question]);

  useEffect(() => {
    return () => {
      nextQuestionPrefetchRef.current?.abortController.abort();
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "queue" || !selectedDeckDetailId) {
      return;
    }

    const shouldLoadQueueStatus =
      !hasLoadedQueueStatusRef.current ||
      loadedQueueSortKeyRef.current !== queueSortKey;

    if (shouldLoadQueueStatus) {
      queueLoadedLimitRef.current = QUEUE_PAGE_SIZE;
      loadedDeckEmbeddingPlotKeyRef.current = null;
      setReviewQueue([]);
      setRecentAttempts([]);
      setReviewQueueTotal(0);
      setDeckEmbeddingPlot(createEmptyDeckEmbeddingPlot());
      setQueueVirtualRange({
        start: 0,
        end: QUEUE_PAGE_SIZE,
      });
      void loadStatus(QUEUE_PAGE_SIZE);
    }

    const events = new EventSource(
      queueStatusStreamUrl(Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current)),
    );

    events.addEventListener("status", (event) => {
      try {
        const data = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as QueueStatusResponse;
        applyQueueStatus(data);
      } catch {
        // Ignore malformed stream events; the connection can continue.
      }
    });

    events.onerror = () => {
      events.close();
      void loadStatus(Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current));
    };

    return () => events.close();
  }, [
    activeTab,
    applyQueueStatus,
    loadStatus,
    queueSortKey,
    queueStatusStreamUrl,
    selectedDeckDetailId,
  ]);

  useEffect(() => {
    if (
      activeTab !== "queue" ||
      !selectedDeckDetailId ||
      reviewQueue.length === 0
    ) {
      return;
    }

    void loadDeckEmbeddingPlot(
      Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current),
    );
  }, [
    activeTab,
    loadDeckEmbeddingPlot,
    reviewQueue.length,
    selectedDeckDetailId,
  ]);

  const gradingEvaluationIds = useMemo(
    () =>
      Array.from(
        new Set(
          messages
            .filter(
              (message): message is Extract<ChatMessage, { kind: "answer" }> =>
                message.kind === "answer" &&
                message.status === "grading" &&
                !message.isOptimistic,
            )
            .map((message) => message.evaluationId),
        ),
      ),
    [messages],
  );
  const gradingEvaluationIdsKey = gradingEvaluationIds.join(",");

  useEffect(() => {
    if (!gradingEvaluationIdsKey) {
      return;
    }

    let isActive = true;
    const ids = gradingEvaluationIdsKey.split(",").filter(Boolean);

    async function pollEvaluationStatus() {
      const params = new URLSearchParams();

      for (const id of ids) {
        params.append("evaluationId", id);
      }

      try {
        const response = await fetch(`/api/evaluation-status?${params.toString()}`, {
          cache: "no-store",
        });

        const data = await readJsonResponse<EvaluationStatusResponse>(
          response,
          "Failed to load evaluation status.",
        );

        if (!isActive || data.evaluations.length === 0) {
          return;
        }

        setEvaluations((current) => {
          const byId = new Map(current.map((evaluation) => [evaluation.id, evaluation]));

          for (const evaluation of data.evaluations) {
            byId.set(evaluation.id, evaluation);
          }

          return Array.from(byId.values()).sort((left, right) => {
            const leftTime = left.resolvedAt ?? left.submittedAt;
            const rightTime = right.resolvedAt ?? right.submittedAt;

            return leftTime - rightTime || left.id.localeCompare(right.id);
          });
        });
      } catch {
        // Evaluation polling is best-effort; SSE and manual refresh can still recover.
      }
    }

    void pollEvaluationStatus();
    const interval = window.setInterval(
      () => void pollEvaluationStatus(),
      EVALUATION_STATUS_POLL_MS,
    );

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [gradingEvaluationIdsKey]);

  useEffect(() => {
    setMessages((current) => {
      let hasChanged = false;

      const nextMessages = current.map((message) => {
        if (message.kind !== "answer") {
          return message;
        }

        const evaluation = evaluations.find(
          (candidate) => candidate.id === message.evaluationId,
        );

        if (!evaluation) {
          return message;
        }

        if (
          message.status === evaluation.status &&
          message.phase === evaluation.phase &&
          message.lastActivityAt === evaluation.lastActivityAt &&
          message.score === evaluation.score &&
          message.justification === evaluation.justification &&
          message.answerSummary === evaluation.answerSummary &&
          message.nextDue === evaluation.nextDue &&
          message.resolvedAt === evaluation.resolvedAt &&
          message.deckId === evaluation.deckId &&
          message.traceId === evaluation.traceId
        ) {
          return message;
        }

        hasChanged = true;

        return {
          ...message,
          status: evaluation.status,
          phase: evaluation.phase,
          lastActivityAt: evaluation.lastActivityAt,
          score: evaluation.score,
          justification: evaluation.justification,
          answerSummary: evaluation.answerSummary,
          nextDue: evaluation.nextDue,
          resolvedAt: evaluation.resolvedAt,
          deckId: evaluation.deckId,
          traceId: evaluation.traceId,
        };
      });

      return hasChanged ? nextMessages : current;
    });
  }, [evaluations]);

  useEffect(() => {
    setMessages((current) => {
      let hasChanged = false;

      const nextMessages = current.map((message) => {
        if (
          message.kind !== "answer" ||
          message.status !== "grading" ||
          currentTime - message.submittedAt < STALE_EVALUATION_GRADING_MS
        ) {
          return message;
        }

        hasChanged = true;

        return {
          ...message,
          status: "resolved" as const,
          phase: null,
          lastActivityAt: currentTime,
          score: null,
          justification:
            "Evaluation did not finish. Try submitting the answer again.",
          answerSummary: message.answer,
          resolvedAt: currentTime,
          nextDue: null,
        };
      });

      return hasChanged ? nextMessages : current;
    });
  }, [currentTime]);

  const submit = useCallback(async (answerOverride?: string) => {
    clearPendingSpeechCommand();
    const activeQuestion = questionRef.current;

    if (!activeQuestion || isSubmittingRef.current) {
      return false;
    }

    const submittedQuestion = activeQuestion;
    const submittedQuestionId = questionIdRef.current;
    const submittedDeckId = currentDeckId;
    const submittedDeckName = currentDeckName;
    const submittedAnswer = (answerOverride ?? answerRef.current).trim();
    const submittedAt = Date.now();
    const optimisticEvaluationId = `pending-${submittedAt}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const optimisticMessageId = `answer-${optimisticEvaluationId}`;

    isSubmittingRef.current = true;
    submitSequenceRef.current += 1;
    const submitSequence = submitSequenceRef.current;
    shouldRefocusAnswerAfterSubmitRef.current = true;
    setIsSubmitting(true);
    setAnswer("");
    answerRef.current = "";
    setSpeechPreview("");
    setError(null);
    setMessages((current) => [
      ...current,
      {
        id: optimisticMessageId,
        kind: "answer",
        questionId: submittedQuestionId,
        deckId: currentDeckId,
        question: submittedQuestion,
        answer: submittedAnswer || "(blank)",
        evaluationId: optimisticEvaluationId,
        traceId: "",
        submittedAt,
        status: "grading",
        isOptimistic: true,
        phase: "queued",
        lastActivityAt: submittedAt,
        score: null,
        justification: null,
        answerSummary: null,
        nextDue: null,
        resolvedAt: null,
      },
    ]);

    let nextQuestionData: NextQuestionResponse | null = null;
    let hasShownNextQuestion = false;
    const optimisticNextQuestionPromise = takePrefetchedNextQuestion(
      learnPanelMode,
      submittedQuestionId,
      submittedQuestion,
    ).then((prefetchedQuestion) => {
      if (!prefetchedQuestion || submitSequenceRef.current !== submitSequence) {
        return null;
      }

      nextQuestionData = prefetchedQuestion;
      hasShownNextQuestion = true;
      applyNextQuestion(prefetchedQuestion, { appendToMessages: false });
      return prefetchedQuestion;
    });

    try {
      const response = await fetch("/api/submit-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          questionId: submittedQuestionId,
          question: submittedQuestion,
          answer: submittedAnswer,
        }),
      });

      const data = await readJsonResponse<SubmitAnswerResponse>(
        response,
        "Failed to submit the answer.",
      );

      if (!data.ok) {
        throw new Error(
          data.ok === false ? data.error : "Failed to submit the answer.",
        );
      }

      setMessages((current) =>
        current.map((message) =>
          message.kind === "answer" &&
          message.evaluationId === optimisticEvaluationId
            ? {
                ...message,
                id: `answer-${data.evaluationId}`,
                evaluationId: data.evaluationId,
                traceId: data.traceId,
                isOptimistic: false,
              }
            : message,
        ),
      );

      if (!hasShownNextQuestion) {
        nextQuestionData = await optimisticNextQuestionPromise;
      }

      if (hasShownNextQuestion && nextQuestionData?.question) {
        appendQuestion(nextQuestionData.question);
      }

      if (!nextQuestionData) {
        nextQuestionData = await loadNextQuestion({
          mode: learnPanelMode,
          excludeQuestionId: submittedQuestionId,
          excludeQuestion: submittedQuestion,
        });
      }

      if (learnPanelMode === "learn" && !nextQuestionData?.question) {
        pendingLearnSourceRef.current = {
          deckId: currentDeckId,
          question: submittedQuestion,
        };
        learnTopUpCooldownUntilRef.current = 0;
        await topUpLearnQueueRef.current?.();
      }

      return true;
    } catch (submitError) {
      submitSequenceRef.current += 1;
      setMessages((current) =>
        current.filter(
          (message) =>
            message.kind !== "answer" ||
            message.evaluationId !== optimisticEvaluationId,
        ),
      );
      setCurrentQuestionId(submittedQuestionId);
      questionIdRef.current = submittedQuestionId;
      setQuestion(submittedQuestion);
      questionRef.current = submittedQuestion;
      setCurrentDeckId(submittedDeckId);
      setCurrentDeckName(submittedDeckName);
      setAnswer(submittedAnswer);
      answerRef.current = submittedAnswer;
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit the answer.",
      );
      return false;
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    applyNextQuestion,
    clearPendingSpeechCommand,
    currentDeckId,
    currentDeckName,
    learnPanelMode,
    loadNextQuestion,
    appendQuestion,
    takePrefetchedNextQuestion,
  ]);

  const skipCurrentQuestion = useCallback(async () => {
    clearPendingSpeechCommand();
    const activeQuestion = questionRef.current;
    const activeQuestionId = questionIdRef.current;

    if (!activeQuestion || isSubmittingRef.current) {
      return false;
    }

    setAnswer("");
    answerRef.current = "";
    setSpeechPreview("");
    setError(null);

    try {
      const response = await fetch("/api/skip-question", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: learnPanelMode,
          questionId: activeQuestionId,
          question: activeQuestion,
        }),
      });

      const data = await readJsonResponse<NextQuestionResponse>(
        response,
        "Failed to skip the question.",
      );
      applyNextQuestion(data);

      return true;
    } catch (skipError) {
      setError(
        skipError instanceof Error
          ? skipError.message
          : "Failed to skip the question.",
      );
      return false;
    }
  }, [applyNextQuestion, clearPendingSpeechCommand, learnPanelMode]);

  const handleSpeechText = useCallback(
    async (transcript: string) => {
      let transcriptToApply = transcript;
      const pendingCommand = pendingSpeechCommandRef.current;

      if (pendingCommand) {
        clearPendingSpeechCommand();
        transcriptToApply = mergeTranscriptText(
          pendingCommand.heldText,
          transcriptToApply,
        );
      }

      const speechCommand = extractTerminalSpeechCommand(
        answerRef.current,
        transcriptToApply,
      );

      if (!speechCommand) {
        appendAnswerText(transcriptToApply);
        return;
      }

      if (speechCommand.command === "submit") {
        setAnswer("");
        answerRef.current = "";
        setSpeechPreview("");
      } else {
        setAnswer(speechCommand.submitAnswer);
        answerRef.current = speechCommand.submitAnswer;
      }

      pendingSpeechCommandRef.current = speechCommand;
      pendingSpeechCommandTimerRef.current = setTimeout(() => {
        const commandToRun = pendingSpeechCommandRef.current;

        if (!commandToRun) {
          return;
        }

        clearPendingSpeechCommand();

        if (commandToRun.command === "submit") {
          void submit(commandToRun.submitAnswer);
          return;
        }

        void skipCurrentQuestion();
      }, SPEECH_COMMAND_SETTLE_MS);
    },
    [
      appendAnswerText,
      clearPendingSpeechCommand,
      skipCurrentQuestion,
      submit,
    ],
  );

  const stopSpeech = useCallback(() => {
    clearPendingSpeechCommand();
    keepListeningRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setSpeechPreview("");
    setSpeechMessage(null);
    setSpeechStatus("idle");
  }, [clearPendingSpeechCommand]);

  const startSpeech = useCallback(() => {
    const SpeechRecognitionConstructor = getSpeechRecognitionConstructor();

    if (!SpeechRecognitionConstructor) {
      setSpeechStatus("unsupported");
      setSpeechMessage("Speech recognition is not available in this browser.");
      return;
    }

    keepListeningRef.current = true;
    setSpeechStatus("starting");
    setSpeechMessage("Starting microphone...");

    const recognition = new SpeechRecognitionConstructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalTranscript = mergeTranscriptText(finalTranscript, transcript);
        } else {
          interimTranscript = mergeTranscriptText(interimTranscript, transcript);
        }
      }

      if (interimTranscript && pendingSpeechCommandRef.current) {
        const pendingCommand = pendingSpeechCommandRef.current;

        clearPendingSpeechCommand();

        if (pendingCommand.command === "submit") {
          const answerToRestore = mergeTranscriptText(
            pendingCommand.submitAnswer,
            pendingCommand.heldText,
          );

          setAnswer(answerToRestore);
          answerRef.current = answerToRestore;
          return;
        }

        appendAnswerText(pendingCommand.heldText);
      }

      setSpeechPreview(interimTranscript);

      if (finalTranscript) {
        setSpeechPreview("");
        void handleSpeechText(finalTranscript);
      }
    };
    recognition.onerror = () => {
      setSpeechStatus("error");
      setSpeechMessage("Microphone transcription stopped.");
    };
    recognition.onend = () => {
      if (!keepListeningRef.current) {
        return;
      }

      try {
        recognition.start();
      } catch {
        setSpeechStatus("error");
        setSpeechMessage("Microphone transcription stopped.");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setSpeechStatus("listening");
      setSpeechMessage("Streaming speech into the answer.");
    } catch {
      setSpeechStatus("error");
      setSpeechMessage("Microphone transcription could not start.");
      return;
    }
  }, [appendAnswerText, clearPendingSpeechCommand, handleSpeechText]);

  useEffect(() => {
    return () => {
      clearPendingSpeechCommand();
      keepListeningRef.current = false;
      recognitionRef.current?.stop();
    };
  }, [clearPendingSpeechCommand]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  const displayedAnswer = speechPreview
    ? mergeTranscriptText(answer, speechPreview)
    : answer;
  const isSpeechActive =
    speechStatus === "starting" ||
    speechStatus === "listening";

  useEffect(() => {
    resizeComposerTextarea(answerInputRef.current);
  }, [displayedAnswer, question]);

  function handleAnswerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      void submit();
    }
  }

  async function saveAvatar(avatarUrl: string | null) {
    setIsAvatarUpdating(true);
    setAvatarMessage(null);

    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatarUrl }),
      });
      const data = (await response.json()) as
        | UserProfileResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in data && data.error ? data.error : "Could not update avatar.",
        );
      }

      setCurrentUser(data as UserProfileResponse);
      setAvatarMessage(avatarUrl ? "Avatar updated." : "Avatar removed.");
    } catch (avatarError) {
      setAvatarMessage(
        avatarError instanceof Error
          ? avatarError.message
          : "Could not update avatar.",
      );
    } finally {
      setIsAvatarUpdating(false);
    }
  }

  async function handleAvatarFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setAvatarMessage("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }

    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      setAvatarMessage("Choose an image under 512 KB.");
      return;
    }

    try {
      const avatarUrl = await readFileAsDataUrl(file);
      await saveAvatar(avatarUrl);
    } catch (avatarError) {
      setAvatarMessage(
        avatarError instanceof Error
          ? avatarError.message
          : "Could not read avatar image.",
      );
    }
  }

  async function addGeneratorContextFiles(selectedFiles: File[]) {
    if (selectedFiles.length === 0) {
      return;
    }

    const contextFiles = await Promise.all(
      selectedFiles.map(async (file) => {
        if (!isTextContextFile(file)) {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: `${file.name} (${file.type || "file"})`,
            status: "metadata-only" as const,
          };
        }

        try {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: await readFileAsText(file),
            status: "ready" as const,
          };
        } catch {
          return {
            id: createClientId("context-file"),
            name: file.name,
            content: file.name,
            status: "metadata-only" as const,
          };
        }
      }),
    );

    setGeneratorFiles((current) => [...current, ...contextFiles]);
    setGeneratorMessage(null);
  }

  async function handleGeneratorFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (isGeneratingQuestions) {
      return;
    }

    await addGeneratorContextFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function removeGeneratorFile(fileId: string) {
    setGeneratorFiles((current) => current.filter((file) => file.id !== fileId));
  }

  async function generateQuestionBatch() {
    if (generatedQuestions.length > 0) {
      setGeneratorMessage("Clear the review queue before generating again.");
      return;
    }

    const count = Math.min(
      MAX_GENERATED_QUESTION_COUNT,
      Math.max(1, generatorQuestionCount),
    );
    const hasContext =
      generatorScope.trim().length > 0 || generatorFiles.length > 0;

    if (!hasContext) {
      setGeneratorMessage("Add a topic or attach context before generating.");
      return;
    }

    setIsGeneratingQuestions(true);
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deckId: selectedDeckDetailId,
          scope: generatorScope,
          files: generatorFiles,
          count,
          difficulty: "Mixed",
          existingQuestions: [
            ...reviewQueue.map((item) => item.question),
          ],
        }),
      });
      const data = (await response.json()) as GenerateQuestionsResponse;

      if (!response.ok || !data.ok) {
        throw new Error(
          !data.ok && data.error ? data.error : "Could not generate questions.",
        );
      }

      const candidates = data.questions.map((item) => ({
        id: createClientId("generated-question"),
        question: item.question,
        conciseAnswer: item.conciseAnswer || "",
        coverageLabel: item.coverageLabel || item.question,
        status: "new" as const,
      }));

      setGeneratedQuestions((current) => [...candidates, ...current]);
      setGeneratorMessage(
        candidates.length > 0
          ? `${candidates.length} generated by ${data.model}.`
          : "OpenRouter returned no new questions.",
      );
    } catch (generateError) {
      setGeneratorMessage(
        generateError instanceof Error
          ? generateError.message
          : "Could not generate questions.",
      );
    } finally {
      setIsGeneratingQuestions(false);
    }
  }

  function toggleGeneratedQuestionSelection(questionId: string) {
    const questionToSelect = generatedQuestions.find(
      (item) => item.id === questionId,
    );

    if (
      !questionToSelect ||
      (questionToSelect.status !== "new" &&
        questionToSelect.status !== "selected")
    ) {
      return;
    }

    setGeneratedQuestions((current) =>
      current.map((item) =>
        item.id === questionId
          ? {
              ...item,
              status: item.status === "selected" ? "new" : "selected",
            }
          : item,
      ),
    );
    setGeneratorMessage(null);
  }

  async function addSelectedGeneratedQuestionsToDeck() {
    const questionsToAdd = generatedQuestions.filter(
      (item) => item.status === "selected",
    );

    if (questionsToAdd.length === 0) {
      return;
    }

    const questionIdsToAdd = new Set(questionsToAdd.map((item) => item.id));

    setGeneratedQuestions((current) =>
      current.map((item) =>
        questionIdsToAdd.has(item.id)
          ? {
              ...item,
              status: "adding",
            }
          : item,
      ),
    );
    setGeneratorMessage(null);

    try {
      const response = await fetch("/api/questions/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deckId: selectedDeckDetailId,
          questions: questionsToAdd.map((item) => ({
            question: item.question,
            conciseAnswer: item.conciseAnswer,
          })),
        }),
      });
      const data = (await response.json()) as
        | { ok: true; added: number; rejected?: number }
        | { ok: false; error?: string };

      if (!response.ok || !data.ok) {
        throw new Error(!data.ok && data.error ? data.error : "Could not add questions.");
      }

      setGeneratedQuestions((current) =>
        current.filter((item) => !questionIdsToAdd.has(item.id)),
      );
      setGeneratorMessage(
        data.added > 0
          ? `${data.added} ${
              data.added === 1 ? "question" : "questions"
            } added to deck${
              data.rejected ? `, ${data.rejected} semantic duplicates rejected` : ""
            }.`
          : questionsToAdd.length === 1
            ? "Question already exists or was rejected as a duplicate."
            : "Questions already exist or were rejected as duplicates.",
      );
      await loadStatus();
      await loadDecks();

      if (!questionRef.current) {
        await loadNextQuestion({ surfaceError: false });
      }

      if (data.added > 0) {
        closeQuestionGenerator();
      }
    } catch (addError) {
      setGeneratorMessage(
        addError instanceof Error
          ? addError.message
          : "Could not add questions.",
      );
      setGeneratedQuestions((current) =>
        current.map((item) =>
          questionIdsToAdd.has(item.id)
            ? {
                ...item,
                status: "selected",
              }
            : item,
        ),
      );
    }
  }

  const activeReviewDeckIds = useMemo(
    () =>
      new Set(
        decks
          .filter((deck) => deck.inReviewRotation)
          .map((deck) => deck.id),
      ),
    [decks],
  );
  const isDeckInReviewRotation = (deckId: string | null | undefined) =>
    deckId == null || decks.length === 0 || activeReviewDeckIds.has(deckId);

  const sessionPreviousAnswers: PreviousAnswerItem[] = messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer" && isDeckInReviewRotation(message.deckId),
    )
    .slice()
    .reverse()
    .map((message) => {
      const timestamp = message.resolvedAt ?? message.submittedAt;

      return {
        id: message.id,
        question: message.question,
        answer: message.answer,
        status: message.status,
        phase: message.phase,
        lastActivityAt: message.lastActivityAt,
        score: message.score,
        justification: message.justification,
        traceId: message.traceId,
        timestamp,
        timeLabel:
          message.status === "grading"
            ? "Just now"
            : formatRelativeTime(timestamp, currentTime),
      };
    });

  const sessionPreviousEvaluationIds = new Set(
    messages
      .filter(
        (message): message is Extract<ChatMessage, { kind: "answer" }> =>
          message.kind === "answer",
      )
      .map((message) => message.evaluationId),
  );

  const evaluationPreviousAnswers: PreviousAnswerItem[] = evaluations
    .filter(
      (evaluation) =>
        isDeckInReviewRotation(evaluation.deckId) &&
        !sessionPreviousEvaluationIds.has(evaluation.id) &&
        evaluation.answer !== null,
    )
    .slice()
    .reverse()
    .map((evaluation) => {
      const timestamp = evaluation.resolvedAt ?? evaluation.submittedAt;

      return {
        id: `evaluation-${evaluation.id}`,
        question: evaluation.question,
        answer: evaluation.answer || "(blank)",
        status: evaluation.status,
        phase: evaluation.phase,
        lastActivityAt: evaluation.lastActivityAt,
        score: evaluation.score,
        justification: evaluation.justification,
        traceId: evaluation.traceId,
        timestamp,
        timeLabel:
          evaluation.status === "grading"
            ? "Just now"
            : formatRelativeTime(timestamp, currentTime),
      };
    });

  const livePreviousQuestions = new Set([
    ...sessionPreviousAnswers.map((previousItem) => previousItem.question),
    ...evaluationPreviousAnswers.map((previousItem) => previousItem.question),
  ]);

  const recentAttemptPreviousAnswers: PreviousAnswerItem[] = recentAttempts
    .filter((attempt) => {
      if (
        !isDeckInReviewRotation(attempt.deckId) ||
        attempt.question === question ||
        livePreviousQuestions.has(attempt.question)
      ) {
        return false;
      }

      return !messages.some((message) => {
        if (message.kind !== "answer") {
          return false;
        }

        return (
          message.question === attempt.question &&
          message.answer === attempt.rawAnswer &&
          Math.abs(message.submittedAt - attempt.submittedAt) < 10_000
        );
      });
    })
    .map((attempt) => ({
      id: `attempt-${attempt.id}`,
      question: attempt.question,
      answer: attempt.rawAnswer || "(blank)",
      status: "resolved",
      phase: null,
      lastActivityAt: null,
      score: attempt.score,
      justification: attempt.justification,
      traceId: null,
      timestamp: attempt.resolvedAt || attempt.submittedAt,
      timeLabel: formatRelativeTime(
        attempt.resolvedAt || attempt.submittedAt,
        currentTime,
      ),
    }));
  const recentAttemptQuestions = new Set(
    recentAttemptPreviousAnswers.map((previousItem) => previousItem.question),
  );

  const historicalPreviousAnswers: PreviousAnswerItem[] = reviewQueue
    .filter(
      (item) =>
        item.lastScore !== null &&
        item.lastAnswer !== null &&
        isDeckInReviewRotation(item.deckId) &&
        item.question !== question &&
        !livePreviousQuestions.has(item.question) &&
        !recentAttemptQuestions.has(item.question),
    )
    .sort((a, b) => {
      const aScore = a.lastScore ?? -1;
      const bScore = b.lastScore ?? -1;

      if ((aScore >= 7) !== (bScore >= 7)) {
        return aScore >= 7 ? -1 : 1;
      }

      return b.nextDue - a.nextDue;
    })
    .slice(0, EXPANDED_PREVIOUS_ANSWER_LIMIT)
    .map((item) => {
      const latestAttempt = item.attempts.at(-1);
      const timestamp =
        latestAttempt?.resolvedAt ??
        latestAttempt?.submittedAt ??
        item.reviewHistory.at(-1)?.ts ??
        null;

      return {
        id: `history-${item.question}`,
        question: item.question,
        answer: item.lastAnswer,
        status: "resolved",
        phase: null,
        lastActivityAt: null,
        score: item.lastScore,
        justification:
          item.lastJustification ??
          "Covers the core idea; a few details could be sharper.",
        traceId: null,
        timestamp,
        timeLabel: formatRelativeTime(timestamp, currentTime),
      };
    });

  const previousAnswers = useMemo(
    () => [
      ...sessionPreviousAnswers,
      ...evaluationPreviousAnswers,
      ...recentAttemptPreviousAnswers,
      ...historicalPreviousAnswers,
    ],
    [
      evaluationPreviousAnswers,
      historicalPreviousAnswers,
      recentAttemptPreviousAnswers,
      sessionPreviousAnswers,
    ],
  );
  const hasPreviousAnswers = previousAnswers.length > 0;
  const visiblePreviousAnswers = isPreviousExpanded
    ? previousAnswers
    : previousAnswers.slice(0, COLLAPSED_PREVIOUS_ANSWER_LIMIT);
  const hasHiddenPreviousAnswers =
    previousAnswers.length > visiblePreviousAnswers.length;
  const isReviewResting = !isLoadingQuestion && !question;
  const activeLearnGenerationProgress =
    learnGenerationProgress ??
    ({
      phase: "memory",
      status: learnGenerationStatus ?? "Preparing new questions",
      progress: 0,
      generated: 0,
      total: 50,
      latestQuestion: null,
    } satisfies LearnGenerationProgress);
  const scheduledReviewCount = reviewQueue.filter(
    (item) => item.status === "scheduled",
  ).length;
  const nextScheduledReview = reviewQueue.find(
    (item) => item.status === "scheduled",
  );
  const sortedReviewQueue = useMemo(() => {
    return [...reviewQueue].sort((a, b) => {
      const dateComparison =
        queueSortKey === "review-date"
          ? a.nextDue - b.nextDue
          : b.createdAt - a.createdAt;

      return dateComparison || a.question.localeCompare(b.question);
    });
  }, [queueSortKey, reviewQueue]);
  const hasMoreReviewQueue = reviewQueue.length < reviewQueueTotal;
  const loadMoreQueueRows = useCallback(() => {
    if (isQueuePageLoadingRef.current || !hasMoreReviewQueue) {
      return;
    }

    const nextLimit = Math.min(
      reviewQueueTotal,
      Math.max(
        reviewQueue.length + QUEUE_PAGE_SIZE,
        Math.ceil(
          Math.max(reviewQueue.length, QUEUE_PAGE_SIZE) *
            QUEUE_PAGE_GROWTH_FACTOR,
        ),
      ),
    );

    if (nextLimit <= reviewQueue.length) {
      return;
    }

    void loadStatus(nextLimit);
  }, [
    hasMoreReviewQueue,
    loadStatus,
    reviewQueue.length,
    reviewQueueTotal,
  ]);
  const updateQueueVirtualRange = useCallback(() => {
    const totalRows = sortedReviewQueue.length;
    const scroller = queueStageRef.current;
    const list = queueListRef.current;

    if (!scroller || !list || totalRows === 0) {
      setQueueVirtualRange({
        start: 0,
        end: Math.min(totalRows, QUEUE_PAGE_SIZE),
      });
      return;
    }

    const listTop = list.offsetTop;
    const visibleTop = Math.max(0, scroller.scrollTop - listTop);
    const visibleBottom = visibleTop + scroller.clientHeight;
    const nextStart = Math.max(
      0,
      Math.floor(visibleTop / QUEUE_ROW_ESTIMATED_HEIGHT) - QUEUE_ROW_OVERSCAN,
    );
    const nextEnd = Math.min(
      totalRows,
      Math.ceil(visibleBottom / QUEUE_ROW_ESTIMATED_HEIGHT) +
        QUEUE_ROW_OVERSCAN,
    );

    setQueueVirtualRange((currentRange) =>
      currentRange.start === nextStart && currentRange.end === nextEnd
        ? currentRange
        : {
            start: nextStart,
            end: nextEnd,
          },
    );
  }, [sortedReviewQueue.length]);
  const visibleQueueRows = sortedReviewQueue.slice(
    queueVirtualRange.start,
    queueVirtualRange.end,
  );
  const queueTopSpacerHeight =
    queueVirtualRange.start * QUEUE_ROW_ESTIMATED_HEIGHT;
  const queueBottomSpacerHeight =
    Math.max(0, sortedReviewQueue.length - queueVirtualRange.end) *
    QUEUE_ROW_ESTIMATED_HEIGHT;
  const previousAnswerPlaceholderCount = isPreviousExpanded
    ? 0
    : !isLoadingQuestion
      ? 0
    : Math.max(
        0,
        COLLAPSED_PREVIOUS_ANSWER_LIMIT - visiblePreviousAnswers.length,
      );
  const topUpLearnQueue = useCallback(async () => {
    const now = Date.now();
    const count = 50;

    if (isLearnTopUpPendingRef.current) {
      return;
    }

    if (now < learnTopUpCooldownUntilRef.current) {
      setLearnGenerationStatus(null);
      setLearnTopUpMessage("Waiting to retry");
      return;
    }

    isLearnTopUpPendingRef.current = true;
    setIsLearnTopUpPending(true);
    setLearnTopUpMessage(null);
    setLearnGenerationStatus("Updating deck memory");
    setLearnGenerationProgress({
      phase: "memory",
      status: "Updating deck memory",
      progress: 0,
      generated: 0,
      total: count,
      latestQuestion: null,
    });

    try {
      const response = await fetch("/api/questions/top-up", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          count,
        }),
      });
      const data = await parseTopUpResponse(response, count, (progress) => {
        setLearnGenerationProgress(progress);
        setLearnGenerationStatus(progress.status);
      });

      if (data.added > 0) {
        learnTopUpSatisfiedKeyRef.current = null;
        setLearnTopUpMessage(
          data.added === 1
            ? `1 question added to ${data.deckName}`
            : `${data.added} questions added to ${data.deckName}`,
        );
        pendingLearnSourceRef.current = null;
        setLearnGenerationStatus("Refreshing the queue");
        setLearnGenerationProgress((currentProgress) => ({
          phase: "complete",
          status: "Refreshing the queue",
          progress: calculateQuestionExtractionProgress({
            generated: data.generated,
            total: currentProgress?.total ?? count,
          }),
          generated: data.generated,
          total: currentProgress?.total ?? count,
          latestQuestion: currentProgress?.latestQuestion ?? null,
        }));
        await loadStatus(Math.max(QUEUE_PAGE_SIZE, queueLoadedLimitRef.current));
        await loadDecks();

        setLearnGenerationStatus("Loading the next question");
        setLearnGenerationProgress((currentProgress) => ({
          phase: "complete",
          status: "Loading the next question",
          progress: calculateQuestionExtractionProgress({
            generated: data.generated,
            total: currentProgress?.total ?? count,
          }),
          generated: data.generated,
          total: currentProgress?.total ?? count,
          latestQuestion: currentProgress?.latestQuestion ?? null,
        }));
        await loadNextQuestion({ mode: "review", surfaceError: false });
      } else {
        learnTopUpCooldownUntilRef.current = Date.now() + LEARN_TOP_UP_COOLDOWN_MS;
        setLearnGenerationStatus(null);
        setLearnGenerationProgress(null);
        setLearnTopUpMessage(
          data.rejected > 0
            ? "Generated questions were duplicates"
            : "No learn questions generated",
        );
      }
    } catch (topUpError) {
      learnTopUpCooldownUntilRef.current = Date.now() + LEARN_TOP_UP_COOLDOWN_MS;
      setLearnGenerationStatus(null);
      setLearnGenerationProgress(null);
      setLearnTopUpMessage(
        topUpError instanceof Error
          ? topUpError.message
          : "Could not generate questions.",
      );
    } finally {
      isLearnTopUpPendingRef.current = false;
      setIsLearnTopUpPending(false);
      setLearnGenerationProgress(null);
    }
  }, [
    loadDecks,
    loadNextQuestion,
    loadStatus,
  ]);

  useEffect(() => {
    topUpLearnQueueRef.current = topUpLearnQueue;
  }, [topUpLearnQueue]);

  const selectedQuestionStats = useMemo<QuestionStats | null>(() => {
    if (!selectedQuestion) {
      return null;
    }

    const matchesSelectedQuestion = (input: {
      questionId?: string | null;
      question: string;
    }) =>
      selectedQuestionId
        ? input.questionId === selectedQuestionId
        : input.question === selectedQuestion;
    const queueItem =
      reviewQueue.find((item) => matchesSelectedQuestion(item)) ?? null;
    const recentQuestionAttempts = recentAttempts.filter(
      (attempt) => matchesSelectedQuestion(attempt),
    );
    const resolvedEvaluations = evaluations.filter(
      (evaluation) =>
        matchesSelectedQuestion(evaluation) &&
        evaluation.status === "resolved" &&
        evaluation.score !== null,
    );
    const latestResolvedEvaluation = resolvedEvaluations.findLast(
      (evaluation) => evaluation.justification,
    );
    const historyMap = new Map<string, ReviewHistoryEntry>();

    for (const entry of queueItem?.reviewHistory ?? []) {
      historyMap.set(`${entry.ts}-${entry.score}`, entry);
    }

    for (const attempt of recentQuestionAttempts) {
      historyMap.set(`${attempt.resolvedAt}-${attempt.score}`, {
        ts: attempt.resolvedAt,
        score: attempt.score,
      });
    }

    for (const evaluation of resolvedEvaluations) {
      const ts = evaluation.resolvedAt ?? evaluation.submittedAt;
      const score = evaluation.score;

      if (score !== null) {
        historyMap.set(`${ts}-${score}`, {
          ts,
          score,
        });
      }
    }

    const reviewHistory = Array.from(historyMap.values()).sort(
      (a, b) => a.ts - b.ts,
    );
    const scores = reviewHistory.map((entry) => entry.score);
    const pendingCount = evaluations.filter(
      (evaluation) =>
        matchesSelectedQuestion(evaluation) &&
        evaluation.status === "grading",
    ).length;
    const selectedAnswerMessages = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer" && matchesSelectedQuestion(message),
    );
    const latestResolvedEvaluationWithNextDue = resolvedEvaluations.findLast(
      (evaluation) => evaluation.nextDue !== null,
    );
    const latestAnswerMessageWithNextDue = selectedAnswerMessages.findLast(
      (message) => message.nextDue !== null,
    );
    const nextDue =
      queueItem?.nextDue ??
      latestResolvedEvaluationWithNextDue?.nextDue ??
      latestAnswerMessageWithNextDue?.nextDue ??
      null;
    const msUntilDue =
      queueItem?.msUntilDue ?? (nextDue === null ? null : nextDue - currentTime);
    const dueStatus =
      queueItem?.status ??
      (msUntilDue === null ? "unknown" : msUntilDue <= 0 ? "now" : "scheduled");
    const lastScore = scores.at(-1) ?? queueItem?.lastScore ?? null;
    const persistedAttempts = [
      ...(queueItem?.attempts ?? []),
      ...recentQuestionAttempts.filter(
        (attempt) =>
          !(queueItem?.attempts ?? []).some(
            (queueAttempt) => queueAttempt.id === attempt.id,
          ),
      ),
    ];
    const persistedAnswerHistory: AnswerHistoryEntry[] =
      persistedAttempts.map((attempt) => ({
        id: `attempt-${attempt.id}`,
        rawAnswer: attempt.rawAnswer || "(blank)",
        answerSummary: attempt.answerSummary || null,
        score: attempt.score,
        justification: attempt.justification || null,
        traceId: null,
        submittedAt: attempt.submittedAt,
        resolvedAt: attempt.resolvedAt,
        status: "resolved",
        phase: null,
        lastActivityAt: null,
      }));
    const sessionAnswerHistory: AnswerHistoryEntry[] = selectedAnswerMessages
      .map((message) => {
        const evaluation = evaluations.find(
          (candidate) => candidate.id === message.evaluationId,
        );

        return {
          id: `session-${message.evaluationId}`,
          rawAnswer: message.answer,
          answerSummary: message.answerSummary,
          score: message.score,
          justification: message.justification,
          traceId: message.traceId,
          submittedAt: evaluation?.submittedAt ?? message.submittedAt,
          resolvedAt: evaluation?.resolvedAt ?? message.resolvedAt,
          status: message.status,
          phase: evaluation?.phase ?? message.phase,
          lastActivityAt: evaluation?.lastActivityAt ?? message.lastActivityAt,
        };
      })
      .filter(
        (messageAttempt) =>
          !persistedAnswerHistory.some(
            (persistedAttempt) =>
              persistedAttempt.rawAnswer === messageAttempt.rawAnswer &&
              persistedAttempt.score === messageAttempt.score &&
              Math.abs(
                persistedAttempt.submittedAt - messageAttempt.submittedAt,
              ) < 10_000,
          ),
      );
    const selectedAnswerEvaluationIds = new Set(
      selectedAnswerMessages.map((message) => message.evaluationId),
    );
    const evaluationAnswerHistory: AnswerHistoryEntry[] = evaluations
      .filter(
        (evaluation) =>
          matchesSelectedQuestion(evaluation) &&
          evaluation.answer !== null &&
          !selectedAnswerEvaluationIds.has(evaluation.id),
      )
      .map((evaluation) => ({
        id: `evaluation-${evaluation.id}`,
        rawAnswer: evaluation.answer || "(blank)",
        answerSummary: evaluation.answerSummary,
        score: evaluation.score,
        justification: evaluation.justification,
        traceId: evaluation.traceId,
        submittedAt: evaluation.submittedAt,
        resolvedAt: evaluation.resolvedAt,
        status: evaluation.status,
        phase: evaluation.phase,
        lastActivityAt: evaluation.lastActivityAt,
      }))
      .filter(
        (evaluationAttempt) =>
          !persistedAnswerHistory.some(
            (persistedAttempt) =>
              persistedAttempt.rawAnswer === evaluationAttempt.rawAnswer &&
              persistedAttempt.score === evaluationAttempt.score &&
              Math.abs(
                persistedAttempt.submittedAt - evaluationAttempt.submittedAt,
              ) < 10_000,
          ),
      );
    const answerHistory = [
      ...persistedAnswerHistory,
      ...sessionAnswerHistory,
      ...evaluationAnswerHistory,
    ].sort((a, b) => b.submittedAt - a.submittedAt);

    return {
      questionId: queueItem?.questionId ?? selectedQuestionId,
      question: selectedQuestion,
      reviewHistory,
      answerHistory,
      attempts: reviewHistory.length,
      averageScore:
        scores.length > 0
          ? scores.reduce((total, score) => total + score, 0) / scores.length
          : null,
      bestScore: scores.length > 0 ? Math.max(...scores) : null,
      lastScore,
      lastReviewedAt: reviewHistory.at(-1)?.ts ?? null,
      nextDue,
      msUntilDue,
      dueStatus,
      pendingCount,
      generatedFromQuestion: queueItem?.generatedFromQuestion ?? null,
      questionProvenance: queueItem?.questionProvenance ?? null,
      conciseAnswer: queueItem?.conciseAnswer ?? null,
      referenceAnswer: queueItem?.referenceAnswer ?? null,
      lastJustification:
        queueItem?.lastJustification ??
        latestResolvedEvaluation?.justification ??
        null,
    };
  }, [
    currentTime,
    evaluations,
    messages,
    recentAttempts,
    reviewQueue,
    selectedQuestionId,
    selectedQuestion,
  ]);

  const selectedReferenceAnswerState = selectedQuestionStats
    ? referenceAnswers[selectedQuestionStats.question]
    : undefined;
  const selectedReferenceAnswer =
    selectedQuestionStats?.referenceAnswer ??
    (selectedReferenceAnswerState?.status === "resolved"
      ? selectedReferenceAnswerState.answer
      : null);
  const isGeneratingReferenceAnswer =
    selectedReferenceAnswerState?.status === "loading";
  const referenceAnswerError =
    selectedReferenceAnswerState?.status === "error"
      ? selectedReferenceAnswerState.answer
      : null;
  const generatedQuestionCounts = generatedQuestions.reduce(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    {
      new: 0,
      selected: 0,
      adding: 0,
      added: 0,
    } satisfies Record<GeneratedQuestionStatus, number>,
  );
  const hasGeneratorContext =
    generatorScope.trim().length > 0 || generatorFiles.length > 0;
  const isGeneratorReviewStep = generatedQuestions.length > 0;
  const shouldShowLearnWaitingMask = learnPanelMode === "learn" && !question;
  const isLearnWaitingBusy = isLoadingQuestion || isLearnTopUpPending;
  const learnWaitingStatus = isLoadingQuestion
    ? "Checking for an available question"
    : learnGenerationStatus ?? learnTopUpMessage ?? "Preparing new questions";
  const learnWaitingTitle = isLearnWaitingBusy
    ? "Generating questions"
    : "No question ready";

  useEffect(() => {
    if (!selectedQuestionStats) {
      return;
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        selectQuestion(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectQuestion, selectedQuestionStats]);

  useEffect(() => {
    if (activeTab !== "queue" || !selectedDeckDetailId) {
      return;
    }

    const stage = queueStageRef.current;

    updateQueueVirtualRange();

    if (!stage) {
      return;
    }

    stage.addEventListener("scroll", updateQueueVirtualRange, { passive: true });
    window.addEventListener("resize", updateQueueVirtualRange);

    return () => {
      stage.removeEventListener("scroll", updateQueueVirtualRange);
      window.removeEventListener("resize", updateQueueVirtualRange);
    };
  }, [
    activeTab,
    selectedDeckDetailId,
    sortedReviewQueue.length,
    updateQueueVirtualRange,
  ]);

  useEffect(() => {
    if (
      activeTab !== "queue" ||
      !selectedDeckDetailId ||
      isQueuePageLoadingRef.current
    ) {
      return;
    }

    const stage = queueStageRef.current;

    if (!stage || !hasMoreReviewQueue) {
      return;
    }

    const distanceToBottom =
      stage.scrollHeight - stage.scrollTop - stage.clientHeight;

    if (distanceToBottom < QUEUE_ROW_ESTIMATED_HEIGHT * 4) {
      loadMoreQueueRows();
    }
  }, [
    activeTab,
    hasMoreReviewQueue,
    loadMoreQueueRows,
    queueVirtualRange.end,
    selectedDeckDetailId,
  ]);

  async function generateReferenceAnswer(
    questionToAnswer: string,
    questionIdToAnswer: string | null,
  ) {
    const storedAnswer =
      reviewQueue.find((item) =>
        questionIdToAnswer
          ? item.questionId === questionIdToAnswer
          : item.question === questionToAnswer,
      )
        ?.referenceAnswer ?? null;

    if (storedAnswer) {
      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "resolved",
          answer: storedAnswer,
        },
      }));
      return;
    }

    setReferenceAnswers((current) => ({
      ...current,
      [questionToAnswer]: {
        status: "loading",
        answer: "Generating reference answer...",
      },
    }));

    try {
      const response = await fetch("/api/reference-answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          questionId: questionIdToAnswer,
          question: questionToAnswer,
        }),
      });

      const data = await readJsonResponse<ReferenceAnswerResponse>(
        response,
        "Failed to generate reference answer.",
      );

      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "resolved",
          answer: data.answer,
        },
      }));
      setReviewQueue((current) =>
        current.map((queueItem) =>
          (questionIdToAnswer
            ? queueItem.questionId === questionIdToAnswer
            : queueItem.question === questionToAnswer)
            ? {
                ...queueItem,
                referenceAnswer: data.answer.startsWith(
                  "Reference answer is unavailable",
                )
                  ? queueItem.referenceAnswer
                  : data.answer,
              }
            : queueItem,
        ),
      );
    } catch {
      setReferenceAnswers((current) => ({
        ...current,
        [questionToAnswer]: {
          status: "error",
          answer: "Reference answer is unavailable right now.",
        },
      }));
    }
  }

  return (
    <main
      className={`page ${
        activeTab === "review" && isPreviousExpanded
          ? "page-previous-expanded"
          : ""
      }`}
    >
      <section className="review-shell" aria-label="Flashcard learning">
        <ReviewToolbar
          activeTab={activeTab === "queue" ? "decks" : "review"}
          dueCount={queueRemaining}
          showAdmin={canViewAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onReviewClick={(event) => navigateToTab("review", event)}
          onDecksClick={(event) => {
            event.preventDefault();
            closeDeckQueue();
          }}
          onManageAccount={() => {
            if (isLocalAuth) {
              setIsSettingsOpen(true);
            } else {
              clerk.openUserProfile({
                customPages: accountWidgetsCustomPages,
              });
            }
          }}
          onSignOut={() => {
            if (isLocalAuth) {
              window.location.assign("/");
            } else {
              void clerk.signOut({ redirectUrl: "/" });
            }
          }}
        />

        <div
          className={`review-stage ${
            !isLoadingQuestion && !question ? "review-stage-resting" : ""
          }`}
          hidden={activeTab !== "review"}
          id="review-panel"
          role="tabpanel"
          aria-labelledby="review-tab"
        >
          <section className="question-area" aria-live="polite">
            <div
              key={isLoadingQuestion ? "loading" : question ?? "empty"}
              className={`question-copy ${
                !isLoadingQuestion && question ? "question-copy-enter" : ""
              }`}
            >
              {shouldShowLearnWaitingMask ? (
                <div
                  className="learn-waiting-mask"
                  aria-busy={isLearnWaitingBusy}
                >
                  <div className="learn-waiting-content">
                    <span className="learn-waiting-icon" aria-hidden="true">
                      <Sparkles />
                    </span>
                    <p className="learn-waiting-kicker">Learn mode</p>
                    <h2 className="learn-waiting-title">{learnWaitingTitle}</h2>
                    <p
                      className="learn-waiting-status"
                      role="status"
                      aria-live="polite"
                    >
                      {learnWaitingStatus}
                    </p>
                    {isLearnWaitingBusy ? (
                      <div className="learn-waiting-progress" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : (
                      <div className="learn-waiting-actions">
                        <button
                          className="resting-primary"
                          type="button"
                          onClick={() => {
                            learnTopUpCooldownUntilRef.current = 0;
                            void topUpLearnQueue();
                          }}
                        >
                          Retry
                        </button>
                        <button
                          className="resting-secondary"
                          type="button"
                          onClick={openQueue}
                        >
                          View queue
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : isLoadingQuestion ? (
                <h2 className="question-title">Loading next question...</h2>
              ) : question ? (
                <>
                  <div className="question-source">
                    {currentDeckName ? (
                      <>
                        <Layers aria-hidden="true" />
                        <span>{currentDeckName}</span>
                      </>
                    ) : null}
                    <button
                      className="question-details-trigger"
                      type="button"
                      aria-label="View current question details"
                      title="Question details"
                      onClick={() => selectQuestion(question, currentQuestionId)}
                    >
                      <Info aria-hidden="true" />
                    </button>
                  </div>
                  <MarkdownInline
                    as="h2"
                    className="question-title"
                    text={question}
                  />
                </>
              ) : isLearnTopUpPending ? (
                <div
                  className="learn-generation-panel"
                  aria-busy="true"
                  aria-labelledby="learn-generation-title"
                >
                  <div className="learn-generation-header">
                    <p className="learn-generation-kicker">
                      Preparing questions
                    </p>
                    <h2
                      className="learn-generation-title"
                      id="learn-generation-title"
                    >
                      Making the next batch.
                    </h2>
                    <p className="learn-generation-status" aria-live="polite">
                      {activeLearnGenerationProgress.status}
                    </p>
                  </div>

                  <div
                    className="learn-generation-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={activeLearnGenerationProgress.progress}
                    aria-label="Question extraction progress"
                  >
                    <span
                      style={{
                        width: `${activeLearnGenerationProgress.progress}%`,
                      }}
                    />
                  </div>

                  <dl className="learn-generation-detail-grid">
                    <div>
                      <dt>{activeLearnGenerationProgress.generated}</dt>
                      <dd>extracted</dd>
                    </div>
                    <div>
                      <dt>{activeLearnGenerationProgress.total}</dt>
                      <dd>requested</dd>
                    </div>
                    <div>
                      <dt>{activeLearnGenerationProgress.progress}%</dt>
                      <dd>of requested</dd>
                    </div>
                  </dl>

                  <div className="learn-generation-stream">
                    <span className="pending-spinner" aria-hidden="true" />
                    <p>
                      {activeLearnGenerationProgress.latestQuestion ??
                        "Waiting for the first complete streamed question."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="resting-state">
                  <p className="resting-kicker">
                    Review complete
                  </p>
                  <h2 className="resting-title">
                    {"You're caught up."}
                  </h2>
                  <p className="resting-copy">
                    {learnTopUpMessage ?? "No questions are due right now."}
                  </p>

                  <dl className="resting-metrics" aria-label="Review status">
                    <div>
                      <dt>{queueRemaining}</dt>
                      <dd>due now</dd>
                    </div>
                    <div>
                      <dt>{scheduledReviewCount}</dt>
                      <dd>scheduled</dd>
                    </div>
                    <div>
                      <dt>
                        {nextScheduledReview
                          ? formatDurationBadge(nextScheduledReview.msUntilDue)
                          : "none"}
                      </dt>
                      <dd>next due</dd>
                    </div>
                  </dl>

                  <div className="resting-actions">
                    <button
                      className="resting-primary"
                      type="button"
                      disabled={isLearnTopUpPending}
                      onClick={() => {
                        learnTopUpCooldownUntilRef.current = 0;
                        void topUpLearnQueue();
                      }}
                    >
                      <Sparkles aria-hidden="true" />
                      <span>Keep learning</span>
                    </button>
                    <button
                      className="resting-secondary"
                      type="button"
                      disabled={isLearnTopUpPending}
                      onClick={openQueue}
                    >
                      View queue
                    </button>
                  </div>

                  {error ? (
                    <p className="resting-error">
                      Could not refresh the next question.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          {isLoadingQuestion ? (
            <div className="composer composer-loading" aria-hidden="true">
              <div className="composer-row composer-loading-row">
                <div className="composer-loading-input" />
                <div className="composer-loading-button" />
                <div className="composer-loading-button composer-loading-button-accent" />
              </div>
            </div>
          ) : question ? (
            <form className="composer" onSubmit={handleSubmit}>
              <div className="composer-row">
                <textarea
                  id="answer-input"
                  ref={answerInputRef}
                  className="composer-input"
                  value={displayedAnswer}
                  onChange={(event) => {
                    clearPendingSpeechCommand();
                    setSpeechPreview("");
                    setAnswer(event.target.value);
                    answerRef.current = event.target.value;
                    resizeComposerTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleAnswerKeyDown}
                  placeholder="Your answer"
                  aria-label="Your answer"
                  rows={4}
                  autoFocus
                  disabled={isSubmitting}
                />
                <button
                  className={`composer-mic ${
                    isSpeechActive ? "composer-mic-active" : ""
                  }`}
                  type="button"
                  aria-label={
                    isSpeechActive ? "Stop voice answer" : "Start voice answer"
                  }
                  aria-pressed={isSpeechActive}
                  onClick={isSpeechActive ? stopSpeech : startSpeech}
                  disabled={isSubmitting}
                  title={
                    isSpeechActive ? "Stop voice answer" : "Start voice answer"
                  }
                >
                  {isSpeechActive ? <StopIcon /> : <MicrophoneIcon />}
                </button>
                <button
                  className="composer-submit"
                  type="submit"
                  disabled={isSubmitting}
                  aria-label="Submit answer"
                >
                  <SubmitIcon />
                </button>
              </div>
              {speechMessage ? (
                <p
                  className={`speech-status speech-status-${speechStatus}`}
                  aria-live="polite"
                >
                  {speechMessage}
                </p>
              ) : null}
            </form>
          ) : null}

          {error && question ? <p className="error-message">{error}</p> : null}

          <section
            className={`previous-panel ${
              isPreviousExpanded ? "previous-panel-expanded" : ""
            }`}
            aria-label="Previous answers"
          >
            <div className="previous-header">
              <h2>Previous answers</h2>
            </div>

            <ol className="previous-list">
              {visiblePreviousAnswers.map((item, index) => {
                const isPending = item.status === "grading";
                const isDetailsExpanded = expandedPreviousAnswerIds.has(item.id);
                const detailId = `previous-answer-details-${index}-${item.id.replace(
                  /[^A-Za-z0-9_-]/g,
                  "-",
                )}`;

                return (
                  <li
                    className={`previous-row ${
                      isPending
                        ? "previous-row-pending"
                        : "previous-row-resolved"
                    } ${
                      isDetailsExpanded
                        ? "previous-row-open"
                        : "previous-row-collapsed"
                    }`}
                    key={item.id}
                  >
                    <div className="previous-score-slot">
                      {isPending ? (
                        <span className="pending-spinner" aria-hidden="true" />
                      ) : (
                        <PreviousAnswerScore score={item.score} />
                      )}
                    </div>

                    <button
                      className="previous-row-main-button"
                      type="button"
                      onClick={() => togglePreviousAnswerDetails(item.id)}
                      aria-expanded={isDetailsExpanded}
                      aria-controls={detailId}
                    >
                      <div className="previous-copy">
                        <div className="previous-field previous-question-field">
                          <span className="previous-field-label">Question</span>
                          <MarkdownInline
                            as="p"
                            className="previous-question"
                            text={item.question}
                          />
                          {isPending ? (
                            <p
                              className="previous-question-feedback previous-question-feedback-pending"
                              aria-live="polite"
                            >
                              Evaluating...
                            </p>
                          ) : (
                            <MarkdownContent
                              className="previous-question-feedback"
                              text={item.justification ?? "No feedback returned."}
                            />
                          )}
                        </div>

                        <div
                          className="previous-detail-grid"
                          hidden={!isDetailsExpanded}
                          id={detailId}
                        >
                          <div className="previous-field">
                            <span className="previous-field-label">Answer</span>
                            {item.answer ? (
                              <MarkdownInline
                                as="p"
                                className="previous-answer"
                                text={item.answer}
                              />
                            ) : (
                              <p className="previous-answer previous-answer-empty">
                                No answer text recorded.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      <span className="previous-row-meta">
                        <time
                          className="previous-time"
                          dateTime={
                            item.timestamp
                              ? new Date(item.timestamp).toISOString()
                              : undefined
                          }
                        >
                          {item.timeLabel}
                        </time>
                        <ChevronDown
                          className="previous-collapse-icon"
                          aria-hidden="true"
                        />
                      </span>
                    </button>

                    {isDetailsExpanded ? (
                      <button
                        className="previous-details-link"
                        type="button"
                        onClick={() => selectQuestion(item.question)}
                      >
                        More details
                      </button>
                    ) : null}
                  </li>
                );
              })}

              {!hasPreviousAnswers && isReviewResting ? (
                <li className="previous-row previous-row-empty">
                  <p>No previous answers yet.</p>
                </li>
              ) : null}

              {Array.from({ length: previousAnswerPlaceholderCount }).map(
                (_, index) => (
                  <li
                    className="previous-row previous-row-placeholder"
                    key={`previous-placeholder-${index}`}
                    aria-hidden="true"
                  >
                    <div className="previous-placeholder-score" />
                    <div className="previous-placeholder-copy">
                      <span />
                      <span />
                    </div>
                  </li>
                ),
              )}
            </ol>
            {hasHiddenPreviousAnswers ? (
              <button
                className="load-more-answers"
                type="button"
                onClick={() => setIsPreviousExpanded(true)}
              >
                Load more
              </button>
            ) : null}
          </section>
        </div>

        <section
          className={`queue-stage ${
            selectedDeckDetailId ? "" : "deck-stage"
          }`}
          ref={queueStageRef}
          hidden={activeTab !== "queue"}
          id="queue-panel"
          role="tabpanel"
          aria-labelledby="queue-tab"
        >
          {selectedDeckDetailId ? (
            <>
              <div className="queue-detail-header">
                <div>
                  <h2>{selectedDeckDetail?.name ?? "Deck"}</h2>
                </div>
              </div>

              <DeckEmbeddingPlot
                plot={deckEmbeddingPlot}
                reviewQueue={reviewQueue}
              />

              <div className="queue-toolbar">
                <button
                  className="queue-generate-trigger"
                  type="button"
                  onClick={openQuestionGenerator}
                >
                  <Sparkles aria-hidden="true" />
                  <span>Generate</span>
                </button>
                <label className="queue-sort-label">
                  Sort by
                  <span className="queue-sort-select-shell">
                    <select
                      className="queue-sort-select"
                      value={queueSortKey}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setQueueSortKey(event.target.value as QueueSortKey)
                      }
                      aria-label="Sort queue"
                    >
                      <option value="review-date">Review date</option>
                      <option value="creation-date">Creation date</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </label>
              </div>

              {reviewQueue.length === 0 ? (
                <p className="queue-empty">
                  {isQueuePageLoading || !hasLoadedQueueStatusRef.current
                    ? "Loading queue..."
                    : "No active cards."}
                </p>
              ) : (
                <ol className="queue-list" ref={queueListRef}>
                  {queueTopSpacerHeight > 0 ? (
                    <li
                      className="queue-spacer"
                      style={{ height: queueTopSpacerHeight }}
                      aria-hidden="true"
                    />
                  ) : null}

                  {visibleQueueRows.map((item) => (
                    <li
                      className="queue-row"
                      key={`${item.question}-${item.nextDue}`}
                    >
                      <div
                        className="queue-row-card"
                        role="button"
                        tabIndex={0}
                        aria-label={`Open card details for ${item.question}`}
                        onClick={() => selectQuestion(item.question, item.questionId)}
                        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectQuestion(item.question, item.questionId);
                          }
                        }}
                      >
                        <div className="queue-row-main">
                          <MarkdownInline
                            as="p"
                            className="queue-question"
                            text={item.question}
                          />
                          {item.questionProvenance || item.generatedFromQuestion ? (
                            <MarkdownInline
                              as="p"
                              className="queue-origin"
                              text={`Provenance: ${
                                item.questionProvenance ??
                                item.generatedFromQuestion
                              }`}
                            />
                          ) : null}
                          <div className="queue-metrics" aria-label="Card metrics">
                            <PreviousAnswerScore
                              className="queue-last-score"
                              label={
                                item.lastScore === null
                                  ? "No previous score"
                                  : `Last score ${item.lastScore} out of 10`
                              }
                              score={item.lastScore}
                            />
                            <span
                              className={`due-badge ${
                                item.status === "now" ? "now" : "scheduled"
                              }`}
                            >
                              {formatDueBadge(item)}
                            </span>
                          </div>
                        </div>
                        {item.lastJustification ? (
                          <p className="queue-justification">
                            {item.lastJustification}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}

                  {queueBottomSpacerHeight > 0 ? (
                    <li
                      className="queue-spacer"
                      style={{ height: queueBottomSpacerHeight }}
                      aria-hidden="true"
                    />
                  ) : null}

                  {hasMoreReviewQueue || isQueuePageLoading ? (
                    <li className="queue-loading-row" aria-live="polite">
                      {isQueuePageLoading
                        ? "Loading more cards..."
                        : `${reviewQueue.length}/${reviewQueueTotal} loaded`}
                    </li>
                  ) : null}
                </ol>
              )}
            </>
          ) : (
            <>
              <div className="queue-toolbar deck-toolbar">
                <button
                  className="queue-generate-trigger"
                  type="button"
                  onClick={createDeck}
                >
                  <Plus aria-hidden="true" />
                  <span>Create deck</span>
                </button>
                <label className="deck-search-label">
                  <span className="sr-only">Search decks</span>
                  <span className="deck-search-shell">
                    <Search aria-hidden="true" />
                    <input
                      className="deck-search-input"
                      type="search"
                      value={deckSearchQuery}
                      onChange={(event) => setDeckSearchQuery(event.target.value)}
                      placeholder="Search decks"
                    />
                  </span>
                </label>
                <label className="queue-sort-label">
                  Sort by
                  <span className="queue-sort-select-shell">
                    <select
                      className="queue-sort-select"
                      value={deckSortKey}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setDeckSortKey(event.target.value as DeckSortKey)
                      }
                      aria-label="Sort decks"
                    >
                      <option value="updated">Updated</option>
                      <option value="due">Due count</option>
                      <option value="name">Name</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </label>
              </div>

              {deckPageMessage ? (
                <p className="queue-empty" role="status">
                  {deckPageMessage}
                </p>
              ) : null}

              {isDecksLoading ? (
                <DeckListLoadingPlaceholders />
              ) : decks.length === 0 ? (
                <p className="queue-empty">No decks yet.</p>
              ) : visibleDecks.length === 0 ? (
                <p className="queue-empty">No matching decks.</p>
              ) : (
                <ol className="queue-list deck-list" ref={queueListRef}>
                  {visibleDecks.map((deck) => {
                    const isSelected = selectedDeck?.id === deck.id;

                    return (
                      <li className="queue-row deck-row" key={deck.id}>
                        <div
                          className={`queue-row-card deck-row-card ${
                            isSelected ? "deck-row-card-selected" : ""
                          }`}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open ${deck.name}`}
                          aria-pressed={isSelected}
                          onClick={() => openDeckQueue(deck)}
                          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openDeckQueue(deck);
                            }
                          }}
                        >
                          <div className="deck-row-main">
                            <div className="deck-row-copy">
                              <p className="queue-question deck-name">{deck.name}</p>
                              {deck.coverage || deck.slug ? (
                                <p className="queue-origin deck-description">
                                  {deck.coverage || deck.slug}
                                </p>
                              ) : null}
                            </div>
                            <div className="deck-row-meta" aria-label="Deck details">
                              <span
                                className={`due-badge ${
                                  deck.dueCount > 0 ? "now" : "scheduled"
                                }`}
                              >
                                {deck.dueCount} due
                              </span>
                              <span>{deck.cardCount} cards</span>
                              <span>{formatReviewDate(deck.lastReviewedAt)}</span>
                            </div>
                          </div>
                          <div className="deck-row-actions">
                            <button
                              className={`deck-rotation-toggle ${
                                deck.inReviewRotation
                                  ? "deck-rotation-toggle-on"
                                  : ""
                              }`}
                              type="button"
                              aria-label={
                                deck.inReviewRotation
                                  ? `Remove ${deck.name} from review rotation`
                                  : `Add ${deck.name} to review rotation`
                              }
                              aria-pressed={deck.inReviewRotation}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleDeckRotation(deck);
                              }}
                            >
                              <span />
                            </button>
                            <button
                              className="deck-icon-button"
                              type="button"
                              aria-label={`Open ${deck.name} settings`}
                              title="Settings"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDeckEditor(deck);
                              }}
                            >
                              <Settings aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="deck-summary-strip" aria-label="Deck summary">
                <span>{decks.length} decks</span>
                <span>{rotationDeckCount} in rotation</span>
                <span>{rotationDueCount} due in rotation</span>
                <span>{totalCardCount} cards</span>
              </div>
            </>
          )}
        </section>
      </section>

      {isCreatingDeck || editingDeck ? (
        <div
          className="deck-editor-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (!isDeckEditorBusy && event.target === event.currentTarget) {
              setIsCreatingDeck(false);
              setEditingDeckId(null);
            }
          }}
        >
          <form
            className="deck-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={isDeckEditorBusy}
            aria-labelledby="deck-editor-title"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDeckDraft();
            }}
          >
            <div className="deck-editor-header">
              <div>
                <p className="previous-field-label">Deck</p>
                <h2 id="deck-editor-title">
                  {isCreatingDeck ? "New deck" : "Edit deck"}
                </h2>
              </div>
              <button
                className="user-menu-trigger"
                type="button"
                aria-label="Close deck editor"
                disabled={isDeckEditorBusy}
                onClick={() => {
                  setIsCreatingDeck(false);
                  setEditingDeckId(null);
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="deck-editor-grid">
              <label className="settings-field">
                <span>Name</span>
                <input
                  className="settings-input"
                  value={deckDraftName}
                  onChange={(event) => {
                    setDeckDraftName(event.target.value);
                    setDeckEditorMessage(null);
                  }}
                  placeholder="Deck name"
                  aria-describedby={
                    deckDraftNameMessage ? "deck-editor-message" : undefined
                  }
                  disabled={isDeckEditorBusy}
                />
              </label>
              <label className="settings-field">
                <span>Covers</span>
                <textarea
                  className="settings-input deck-coverage-input"
                  value={deckDraftCoverage}
                  onChange={(event) => {
                    setDeckDraftCoverage(event.target.value);
                    setDeckEditorMessage(null);
                  }}
                  placeholder="Topics, boundaries, and intended question material"
                  maxLength={2000}
                  rows={5}
                  disabled={isDeckEditorBusy}
                />
              </label>
            </div>

            {deckDraftNameMessage ? (
              <p
                className="deck-editor-status"
                id="deck-editor-message"
                role="alert"
              >
                {deckDraftNameMessage}
              </p>
            ) : null}

            <div className="deck-editor-stats" aria-label="Deck question summary">
              <div>
                <dt>{editingDeck?.cardCount ?? 0}</dt>
                <dd>questions</dd>
              </div>
              <div>
                <dt>{editingDeck?.dueCount ?? 0}</dt>
                <dd>due</dd>
              </div>
              <div>
                <dt>{editingDeck?.inReviewRotation ? "on" : "off"}</dt>
                <dd>rotation</dd>
              </div>
            </div>

            <div className="deck-editor-actions">
              {!isCreatingDeck && editingDeck ? (
                <button
                  className="deck-delete-link"
                  type="button"
                  disabled={isDeckEditorBusy}
                  onClick={() => {
                    void deleteEditingDeck();
                  }}
                >
                  {isDeckDeleting ? "Deleting..." : "Delete deck"}
                </button>
              ) : (
                <span className="deck-editor-action-spacer" aria-hidden="true" />
              )}
              <div className="deck-editor-action-buttons">
                <button
                  className="resting-secondary"
                  type="button"
                  disabled={isDeckEditorBusy}
                  onClick={() => {
                    setIsCreatingDeck(false);
                    setEditingDeckId(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="resting-primary"
                  type="submit"
                  disabled={!canSaveDeckDraft}
                >
                  {isDeckSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {isQuestionGeneratorOpen ? (
        <div
          className="generator-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isGeneratingQuestions) {
              closeQuestionGenerator();
            }
          }}
        >
          <section
            className="generator-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={isGeneratingQuestions}
            aria-labelledby="generator-modal-title"
          >
            {isGeneratingQuestions ? (
              <div className="generator-progress-mask" role="status">
                <div className="generator-progress-content">
                  <Sparkles aria-hidden="true" />
                  <strong>Generating questions</strong>
                  <span>Please wait...</span>
                </div>
              </div>
            ) : null}

            <div className="generator-modal-header">
              <div>
                <p className="generator-modal-kicker">
                  {isGeneratorReviewStep ? "Step 2 of 2" : "Step 1 of 2"}
                </p>
                <h2 className="generator-modal-title" id="generator-modal-title">
                  {isGeneratorReviewStep ? "Review questions" : "Generate questions"}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close generator"
                disabled={isGeneratingQuestions}
                onClick={closeQuestionGenerator}
              />
            </div>

            <div
              className={`generator-modal-grid ${
                isGeneratorReviewStep
                  ? "generator-modal-grid-review"
                  : "generator-modal-grid-scope"
              }`}
            >
              {!isGeneratorReviewStep ? (
                <section className="generator-scope-panel" aria-label="Generation scope">
                  <div className="generator-field">
                    <label htmlFor="generator-scope-input">Cover</label>
                    <div
                      className="generator-scope-shell"
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = isGeneratingQuestions
                          ? "none"
                          : "copy";
                      }}
                      onDrop={(event) => void handleGeneratorFileDrop(event)}
                    >
                      <textarea
                        id="generator-scope-input"
                        className="generator-scope-input"
                        value={generatorScope}
                        disabled={isGeneratingQuestions}
                        onChange={(event) => {
                          setGeneratorScope(event.target.value);
                          setGeneratorMessage(null);
                        }}
                        placeholder="Core ideas from the attached lecture notes"
                        rows={7}
                      />
                      <p className="generator-drop-hint">
                        Drop files here to add them as context.
                      </p>
                      {generatorFiles.length > 0 ? (
                        <ul className="generator-file-list" aria-label="Context files">
                          {generatorFiles.map((file) => (
                            <li className="generator-file-chip" key={file.id}>
                              <FileText aria-hidden="true" />
                              <span>{file.name}</span>
                              {file.status === "metadata-only" ? (
                                <em>name only</em>
                              ) : null}
                              <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                disabled={isGeneratingQuestions}
                                onClick={() => removeGeneratorFile(file.id)}
                              >
                                <X aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>

                  <div className="generator-controls">
                    <label className="generator-slider-field">
                      <span className="generator-slider-header">
                        <span>Questions</span>
                        <output>{generatorQuestionCount}</output>
                      </span>
                      <input
                        className="generator-count-slider"
                        type="range"
                        min={1}
                        max={MAX_GENERATED_QUESTION_COUNT}
                        step={1}
                        value={generatorQuestionCount}
                        disabled={isGeneratingQuestions}
                        onChange={(event) =>
                          setGeneratorQuestionCount(
                            Number.parseInt(event.target.value, 10),
                          )
                        }
                      />
                      <span className="generator-slider-scale" aria-hidden="true">
                        <span>1</span>
                        <span>{MAX_GENERATED_QUESTION_COUNT}</span>
                      </span>
                    </label>
                  </div>

                  <div className="generator-scope-footer">
                    <p aria-live="polite">{generatorMessage}</p>
                    <button
                      className="generator-primary-action"
                      type="button"
                      onClick={() => void generateQuestionBatch()}
                      disabled={!hasGeneratorContext || isGeneratingQuestions}
                    >
                      <Sparkles aria-hidden="true" />
                      <span>{isGeneratingQuestions ? "Generating..." : "Generate"}</span>
                    </button>
                  </div>
                </section>
              ) : (
                <section className="generator-review-panel" aria-label="Generated questions">
                <div className="generator-review-header">
                  <div>
                    <h3>Generated</h3>
                    <p>
                      {generatedQuestionCounts.new} available ·{" "}
                      {generatedQuestionCounts.selected} selected
                    </p>
                  </div>
                  {generatedQuestionCounts.adding > 0 ? (
                    <span>{generatedQuestionCounts.adding} adding</span>
                  ) : null}
                </div>

                <ol className="generator-question-list">
                  {generatedQuestions.map((item) => (
                    <li
                      className={`generator-question-row generator-question-${item.status}`}
                      key={item.id}
                    >
                      <button
                        className="generator-question-status"
                        type="button"
                        aria-label={
                          item.status === "new"
                            ? `Select question for adding: ${item.question}`
                            : item.status === "selected"
                              ? `Remove question from add selection: ${item.question}`
                              : "Adding question"
                        }
                        disabled={item.status === "adding"}
                        onClick={() => toggleGeneratedQuestionSelection(item.id)}
                      >
                        {item.status === "selected" ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <Plus aria-hidden="true" />
                        )}
                      </button>
                      <div className="generator-question-copy">
                        <MarkdownInline
                          as="p"
                          className="generator-question-text"
                          text={item.question}
                        />
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="generator-review-footer">
                  <p aria-live="polite">
                    {generatorMessage ??
                      (generatedQuestionCounts.selected > 0
                        ? `${generatedQuestionCounts.selected} selected for add.`
                        : generatedQuestionCounts.new > 0
                          ? "Click + on any question to select it."
                          : "Add selected questions to the deck.")}
                  </p>
                  <div className="generator-review-actions">
                    <button
                      className="generator-primary-action"
                      type="button"
                      onClick={() => void addSelectedGeneratedQuestionsToDeck()}
                      disabled={
                        generatedQuestionCounts.selected === 0 ||
                        generatedQuestionCounts.adding > 0
                      }
                    >
                      {generatedQuestionCounts.adding > 0 ? "Adding..." : "Add to Deck"}
                    </button>
                  </div>
                </div>
              </section>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
          >
            <div className="settings-modal-header">
              <div>
                <p className="settings-modal-kicker">User settings</p>
                <h2 className="settings-modal-title" id="settings-modal-title">
                  Profile
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close settings"
                onClick={() => setIsSettingsOpen(false)}
              />
            </div>

            <div className="settings-profile">
              <div className="settings-avatar-preview" aria-hidden="true">
                {menuAvatarUrl ? (
                  <span
                    className="settings-avatar-image"
                    style={{ backgroundImage: `url("${menuAvatarUrl}")` }}
                  />
                ) : (
                  <UserIcon />
                )}
              </div>

              <div className="settings-profile-copy">
                <dl className="settings-profile-details">
                  <div>
                    <dt>Name</dt>
                    <dd>{currentUser?.displayName ?? "Loading..."}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{currentUser?.email ?? "Loading..."}</dd>
                  </div>
                </dl>

                <div className="settings-avatar-actions">
                  <input
                    ref={avatarInputRef}
                    className="settings-avatar-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => void handleAvatarFileChange(event)}
                  />
                  <button
                    className="settings-action-primary"
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={isAvatarUpdating}
                  >
                    <UploadIcon />
                    <span>
                      {isAvatarUpdating ? "Uploading..." : "Upload avatar"}
                    </span>
                  </button>
                  <button
                    className="settings-action-secondary"
                    type="button"
                    onClick={() => void saveAvatar(null)}
                    disabled={isAvatarUpdating || !currentUser?.avatarUrl}
                  >
                    <RemoveIcon />
                    <span>Remove</span>
                  </button>
                </div>

                {avatarMessage ? (
                  <p className="settings-status" aria-live="polite">
                    {avatarMessage}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {selectedQuestionStats ? (
        <div
          className="stats-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              selectQuestion(null);
            }
          }}
        >
          <section
            className="stats-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stats-modal-title"
          >
            <div className="stats-modal-header">
              <div>
                <p className="stats-modal-kicker">Question stats</p>
                <MarkdownInline
                  as="h2"
                  className="stats-modal-title"
                  text={selectedQuestionStats.question}
                />
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close stats"
                onClick={() => selectQuestion(null)}
              />
            </div>

            <div className="stats-grid" aria-label="Question summary metrics">
              <div className="stats-tile">
                <span>Attempts</span>
                <strong>{selectedQuestionStats.attempts}</strong>
              </div>
              <div className="stats-tile">
                <span>Average</span>
                <strong>{formatAverageScore(selectedQuestionStats.averageScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Best</span>
                <strong>{formatScore(selectedQuestionStats.bestScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Last</span>
                <strong>{formatScore(selectedQuestionStats.lastScore)}</strong>
              </div>
              <div className="stats-tile">
                <span>Next due</span>
                <strong>{formatNextDue(selectedQuestionStats)}</strong>
              </div>
              <div className="stats-tile">
                <span>Pending</span>
                <strong>{selectedQuestionStats.pendingCount}</strong>
              </div>
            </div>

            <div className="stats-chart-panel">
              <div className="stats-section-heading">
                <h3>Previous scores</h3>
                <span>
                  Last reviewed {formatReviewDate(selectedQuestionStats.lastReviewedAt)}
                </span>
              </div>
              <ScoreChart entries={selectedQuestionStats.reviewHistory} />
            </div>

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Answer history</h3>
                <span>{selectedQuestionStats.dueStatus}</span>
              </div>
              {selectedQuestionStats.answerHistory.length === 0 ? (
                <p className="stats-empty">No answers recorded yet.</p>
              ) : (
                <ol className="stats-history-list">
                  {selectedQuestionStats.answerHistory.map((entry) => {
                    const isPending = entry.status === "grading";

                    return (
                      <li
                        className={`stats-history-row ${
                          isPending
                            ? "stats-history-row-pending"
                            : "stats-history-row-resolved"
                        }`}
                        key={entry.id}
                      >
                        <div className="stats-history-score-slot">
                          {isPending ? (
                            <span className="pending-spinner" aria-hidden="true" />
                          ) : (
                            <PreviousAnswerScore score={entry.score} />
                          )}
                        </div>

                        <div className="stats-history-copy">
                          <div className="previous-field stats-history-answer-field">
                            <span className="previous-field-label">Answer</span>
                            <p className="stats-history-answer">
                              {entry.rawAnswer}
                            </p>
                          </div>

                          {entry.answerSummary &&
                          entry.answerSummary !== entry.rawAnswer ? (
                            <div className="previous-field">
                              <span className="previous-field-label">
                                Summary
                              </span>
                              <p className="stats-history-summary">
                                {entry.answerSummary}
                              </p>
                            </div>
                          ) : null}
                          <div className="previous-field">
                            <span className="previous-field-label">
                              Evaluation
                            </span>
                            {entry.justification ? (
                              <p className="stats-history-summary">
                                {entry.justification}
                              </p>
                            ) : (
                              <p className="stats-history-summary stats-history-summary-muted">
                                {isPending
                                  ? `${formatEvaluationPhase(
                                      entry.phase,
                                    )}... ${formatEvaluationActivity(
                                      entry.lastActivityAt,
                                      currentTime,
                                    )}`
                                  : "No feedback returned."}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="stats-history-row-meta">
                          <time
                            className="previous-time"
                            dateTime={new Date(
                              entry.resolvedAt ?? entry.submittedAt,
                            ).toISOString()}
                          >
                            {formatReviewDate(
                              entry.resolvedAt ?? entry.submittedAt,
                            )}
                          </time>
                          <span className="stats-history-status">
                            {isPending
                              ? formatEvaluationPhase(entry.phase)
                              : "Resolved"}
                          </span>
                          {canViewAdmin && entry.traceId ? (
                            <Link
                              className="stats-history-trace-link"
                              href={`/admin/traces/${encodeURIComponent(
                                entry.traceId,
                              )}`}
                            >
                              View trace
                            </Link>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {selectedQuestionStats.lastJustification ? (
                <div className="stats-feedback">
                  <span>Latest feedback</span>
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedQuestionStats.lastJustification}
                  />
                </div>
              ) : null}
              {selectedQuestionStats.generatedFromQuestion ? (
                <div className="stats-feedback">
                  <span>Generated from</span>
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedQuestionStats.generatedFromQuestion}
                  />
                </div>
              ) : null}
              {selectedQuestionStats.questionProvenance ? (
                <div className="stats-feedback">
                  <span>Provenance</span>
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedQuestionStats.questionProvenance}
                  />
                </div>
              ) : null}
              <div className="stats-feedback">
                <div className="stats-reference-header">
                  <span>LLM answer</span>
                  {!selectedReferenceAnswer ? (
                    <button
                      className="stats-generate-answer"
                      type="button"
                      onClick={() =>
                        void generateReferenceAnswer(
                          selectedQuestionStats.question,
                          selectedQuestionStats.questionId,
                        )
                      }
                      disabled={isGeneratingReferenceAnswer}
                    >
                      {isGeneratingReferenceAnswer
                        ? "Generating..."
                        : "Generate answer"}
                    </button>
                  ) : null}
                </div>
                {selectedReferenceAnswer ? (
                  <MarkdownContent
                    className="stats-feedback-copy"
                    text={selectedReferenceAnswer}
                  />
                ) : referenceAnswerError ? (
                  <p className="stats-reference-empty">{referenceAnswerError}</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
