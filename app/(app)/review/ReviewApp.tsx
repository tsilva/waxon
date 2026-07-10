"use client";

import Link from "next/link";
import {
  AnswerComposer,
  ComposerMicButton,
} from "@/app/AnswerComposer";
import { useAppError } from "@/app/AppErrorModal";
import { libraryTagHref } from "@/app/lib/libraryTagNavigation";
import { SCHEDULED_SCORE_THRESHOLD } from "@/app/lib/scheduler";
import {
  deferredReviewRetryQuestionIds,
  mergeDeferredReviewRetryItem,
  placeReviewRetryQuestion,
  releaseDeferredReviewRetries,
  type ReviewRetryQuestionIdentity,
} from "@/app/lib/reviewRetryQueue";
import {
  getSpeechRecognitionConstructor,
  mergeTranscriptText,
  type SpeechRecognition,
  type SpeechStatus,
} from "@/app/lib/speechRecognition";
import { useToolbarAccount } from "@/app/lib/useToolbarAccount";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";
import {
  MarkdownContent as SharedMarkdownContent,
  MarkdownInline as SharedMarkdownInline,
} from "@/app/MarkdownContent";
import {
  PreviousAnswerRow,
  PreviousAnswerScore,
} from "@/app/PreviousAnswerRow";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { localSettingsEvent } from "@/app/toolbarEvents";
import { ScoreChart } from "./ReviewVisualizations";
import { formatDurationBadge } from "./reviewFormatting";
import type {
  EvaluationPhase,
  EvaluationQueueItem,
  QuestionAttempt,
  ReviewHistoryEntry,
  ReviewQueueItem,
} from "@/app/lib/reviewTypes";
import type { UserProfile } from "@/app/lib/userProfile";
import {
  Flag,
  Info,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type NextQuestionResponse = {
  questionId: string | null;
  question: string | null;
  queueRemaining: number;
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
  nextScheduledDue?: number | null;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts?: QuestionAttempt[];
};

type ReviewSessionQueueResponse = {
  items: ReviewQueueItem[];
};

type EvaluationStatusResponse = {
  evaluations: EvaluationQueueItem[];
};

type QuestionAttemptsResponse = {
  attempts: QuestionAttempt[];
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
      correctAnswer: string | null;
      nextDue: number | null;
      resolvedAt: number | null;
      cost: number | null;
    };

type PreviousAnswerItem = {
  id: string;
  questionId: string | null;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number | null;
  score: number | null;
  justification: string | null;
  correctAnswer: string | null;
  traceId: string | null;
  cost: number | null;
  timestamp: number | null;
  timeLabel: string;
  nextDue: number | null;
};

type QuestionSwapLayer = {
  key: string;
  questionId: string | null;
  question: string;
  conceptSlugs: string[];
  phase: "current" | "entering" | "exiting";
};

type ReviewSessionSnapshot = {
  currentQuestionId: string | null;
  question: string | null;
  currentSessionItem: ReviewQueueItem | null;
  sessionQueue: ReviewQueueItem[];
  answer: string;
  speechPreview: string;
  queueRemaining: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  messages: ChatMessage[];
  isPreviousExpanded: boolean;
  expandedPreviousAnswerIds: Set<string>;
  selectedQuestionId: string | null;
  selectedQuestion: string | null;
  currentUser: UserProfile | null;
  hasLoadedQuestion: boolean;
};

let reviewSessionSnapshot: ReviewSessionSnapshot | null = null;

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

type PendingSpeechCommand = {
  command: "submit";
  heldText: string;
  submitAnswer: string;
};

async function fetchReviewSessionQueue(input: {
  excludeQuestionId?: string | null;
  excludeQuestionIds?: Array<string | null | undefined>;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
} = {}): Promise<ReviewQueueItem[]> {
  const params = new URLSearchParams();

  if (input.excludeQuestionId) {
    params.append("excludeQuestionId", input.excludeQuestionId);
  }

  for (const questionId of input.excludeQuestionIds ?? []) {
    if (questionId) {
      params.append("excludeQuestionId", questionId);
    }
  }

  if (input.limit !== undefined) {
    params.set("limit", String(Math.max(0, Math.floor(input.limit))));
  }

  if (input.offset !== undefined) {
    params.set("offset", String(Math.max(0, Math.floor(input.offset))));
  }

  const response = await fetch(
    params.size > 0 ? `/api/review-queue?${params.toString()}` : "/api/review-queue",
    {
      cache: "no-store",
      signal: input.signal,
    },
  );
  const data = await readJsonResponse<ReviewSessionQueueResponse>(
    response,
    "Failed to load the review queue.",
  );

  return data.items;
}

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
  lastJustification: string | null;
  conceptSlugs: string[];
};

type AnswerHistoryEntry = {
  id: string;
  rawAnswer: string;
  answerSummary: string | null;
  score: number | null;
  justification: string | null;
  correctAnswer: string | null;
  traceId: string | null;
  submittedAt: number;
  resolvedAt: number | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number | null;
};

const COLLAPSED_PREVIOUS_ANSWER_LIMIT = 2;
const EXPANDED_PREVIOUS_ANSWER_LIMIT = 24;
const REVIEW_SESSION_FIRST_ITEM_LIMIT = 1;
const REVIEW_SESSION_LOOKAHEAD_LIMIT = 4;
const REVIEW_SESSION_LOOKAHEAD_LOW_WATERMARK = 2;
const SPEECH_COMMAND_SETTLE_MS = 1000;
const STALE_EVALUATION_GRADING_MS = 120_000;
const EVALUATION_STATUS_POLL_MS = 750;
const QUESTION_SWAP_ANIMATION_MS = 140;

const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;
const TERMINAL_SPEECH_COMMAND = /(?:^|\s)(submit)[.!?]*$/i;

function questionSwapLayerKey(
  questionId: string | null,
  question: string,
): string {
  return questionId ? `question-${questionId}` : `question-${question}`;
}

function reviewSessionItemKey(item: Pick<ReviewQueueItem, "questionId" | "question">): string {
  return item.questionId ?? `question:${item.question}`;
}

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

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: (tooltipId: string) => ReactNode;
}) {
  const tooltipId = useId();

  return (
    <span className="icon-tooltip">
      <span className="icon-tooltip-bubble" id={tooltipId} role="tooltip">
        {label}
      </span>
      {children(tooltipId)}
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

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatRelativeTime(timestamp: number | null, now: number): string {
  if (!timestamp) {
    return "just now";
  }

  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return "just now";
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

function questionAttemptCacheKey(input: {
  questionId: string | null;
  question: string;
}): string {
  return input.questionId ? `id:${input.questionId}` : `question:${input.question}`;
}

function reviewQueueItemPreviousTimestamp(item: ReviewQueueItem): number | null {
  const latestAttempt = item.attempts.at(-1);

  return (
    latestAttempt?.resolvedAt ??
    latestAttempt?.submittedAt ??
    item.reviewHistory.at(-1)?.ts ??
    null
  );
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

function formatPreviousAnswerScheduleLabel(
  nextDue: number | null,
  now: number,
): string | null {
  if (nextDue === null) {
    return null;
  }

  const msUntilDue = nextDue - now;
  if (msUntilDue <= 0) {
    return "due now";
  }

  return `due in ${formatDurationBadge(msUntilDue).toLowerCase()}`;
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

  if (command !== "submit") {
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

export default function ReviewApp() {
  const cachedSessionRef = useRef(reviewSessionSnapshot);
  const cachedHasLoadedQuestion =
    cachedSessionRef.current?.hasLoadedQuestion ?? false;
  const hasLoadedQuestionRef = useRef(cachedHasLoadedQuestion);
  const hasLoadedPreviousAnswerStatusRef = useRef(false);
  const [question, setQuestion] = useState<string | null>(
    () => cachedSessionRef.current?.question ?? null,
  );
  const [questionSwapLayers, setQuestionSwapLayers] = useState<
    QuestionSwapLayer[]
  >(() => {
    const cachedQuestion = cachedSessionRef.current?.question ?? null;

    return cachedQuestion
      ? [
          {
            key: questionSwapLayerKey(
              cachedSessionRef.current?.currentQuestionId ?? null,
              cachedQuestion,
            ),
            questionId: cachedSessionRef.current?.currentQuestionId ?? null,
            question: cachedQuestion,
            conceptSlugs:
              cachedSessionRef.current?.currentSessionItem?.conceptSlugs ?? [],
            phase: "current",
          },
        ]
      : [];
  });
  const [currentSessionItem, setCurrentSessionItem] =
    useState<ReviewQueueItem | null>(
      () => cachedSessionRef.current?.currentSessionItem ?? null,
    );
  const [sessionQueue, setSessionQueue] = useState<ReviewQueueItem[]>(
    () => cachedSessionRef.current?.sessionQueue ?? [],
  );
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    () => cachedSessionRef.current?.currentQuestionId ?? null,
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
  const [toolbarDueCount, setToolbarDueCount] = useState<number | null>(
    () => cachedSessionRef.current?.queueRemaining ?? null,
  );
  const [evaluations, setEvaluations] = useState<EvaluationQueueItem[]>(
    () => cachedSessionRef.current?.evaluations ?? [],
  );
  const [recentAttempts, setRecentAttempts] = useState<QuestionAttempt[]>(
    () => cachedSessionRef.current?.recentAttempts ?? [],
  );
  const [questionAttemptsByKey, setQuestionAttemptsByKey] = useState<
    Record<string, QuestionAttempt[]>
  >({});
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => cachedSessionRef.current?.messages ?? [],
  );
  const [isPreviousExpanded, setIsPreviousExpanded] = useState(
    () => cachedSessionRef.current?.isPreviousExpanded ?? false,
  );
  const [isLoadingMorePreviousAnswers, setIsLoadingMorePreviousAnswers] =
    useState(false);
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
  const [isFlaggingQuestion, setIsFlaggingQuestion] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(
    () => cachedSessionRef.current?.currentUser ?? null,
  );
  const [isAvatarUpdating, setIsAvatarUpdating] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const {
    canViewAdmin,
    menuAvatarUrl,
    menuDisplayName,
    menuEmail,
    onManageAccount,
    onSignOut,
  } = useToolbarAccount(currentUser, {
    localSignOutHref: "/",
    onLocalManageAccount: () => setIsSettingsOpen(true),
  });
  const [error, setError] = useState<string | null>(null);
  const { showError } = useAppError();
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [reviewQueueVersion] = useState(0);
  const answerRef = useRef(answer);
  const questionRef = useRef(question);
  const questionSwapTimerRef = useRef<number | null>(null);
  const questionIdRef = useRef(currentQuestionId);
  const currentSessionItemRef = useRef(currentSessionItem);
  const sessionQueueRef = useRef(sessionQueue);
  const reviewSessionReloadGenerationRef = useRef(0);
  const isReviewSessionBackgroundLoadingRef = useRef(false);
  const isFlaggingQuestionRef = useRef(isFlaggingQuestion);
  const pendingRetryItemsRef = useRef(new Map<string, ReviewQueueItem>());
  const deferredRetryItemsRef = useRef<ReviewQueueItem[]>([]);
  const processedEvaluationIdsRef = useRef(new Set<string>());
  const questionAttemptsRequestKeysRef = useRef(new Set<string>());
  const answerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const isSubmittingRef = useRef(isSubmitting);
  const shouldRefocusAnswerAfterSubmitRef = useRef(false);
  const keepListeningRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const pendingSpeechCommandRef = useRef<PendingSpeechCommand | null>(null);
  const surfaceReviewError = useCallback(
    (message: string, details?: string | null) => {
      setError(message);
      showError({
        title: "Review error",
        message,
        details,
      });
    },
    [showError],
  );
  const pendingSpeechCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    return () => {
      if (questionSwapTimerRef.current) {
        window.clearTimeout(questionSwapTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!question) {
      if (!isLoadingQuestion) {
        setQuestionSwapLayers([]);
      }

      return;
    }

    const nextLayer: QuestionSwapLayer = {
      key: questionSwapLayerKey(currentQuestionId, question),
      questionId: currentQuestionId,
      question,
      conceptSlugs: currentSessionItem?.conceptSlugs ?? [],
      phase: "entering",
    };

    if (questionSwapTimerRef.current) {
      window.clearTimeout(questionSwapTimerRef.current);
      questionSwapTimerRef.current = null;
    }

    setQuestionSwapLayers((currentLayers) => {
      const activeLayer =
        currentLayers.find((layer) => layer.phase !== "exiting") ??
        currentLayers.at(-1);

      if (!activeLayer) {
        return [{ ...nextLayer, phase: "entering" }];
      }

      if (activeLayer.key === nextLayer.key) {
        return [{ ...nextLayer, phase: activeLayer.phase }];
      }

      return [
        { ...activeLayer, phase: "exiting" },
        nextLayer,
      ];
    });

    questionSwapTimerRef.current = window.setTimeout(() => {
      setQuestionSwapLayers((currentLayers) =>
        currentLayers
          .filter((layer) => layer.key === nextLayer.key)
          .map((layer) => ({ ...layer, phase: "current" })),
      );
      questionSwapTimerRef.current = null;
    }, QUESTION_SWAP_ANIMATION_MS);
  }, [
    currentQuestionId,
    currentSessionItem,
    isLoadingQuestion,
    question,
  ]);

  useEffect(() => {
    questionIdRef.current = currentQuestionId;
  }, [currentQuestionId]);

  useEffect(() => {
    currentSessionItemRef.current = currentSessionItem;
  }, [currentSessionItem]);

  useEffect(() => {
    sessionQueueRef.current = sessionQueue;
  }, [sessionQueue]);

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  useEffect(() => {
    isFlaggingQuestionRef.current = isFlaggingQuestion;
  }, [isFlaggingQuestion]);

  useEffect(() => {
    if (!shouldRefocusAnswerAfterSubmitRef.current) {
      return;
    }

    if (!isSubmitting && !question) {
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
  }, [isSubmitting, question]);

  useEffect(() => {
    reviewSessionSnapshot = {
      currentQuestionId,
      question,
      currentSessionItem,
      sessionQueue,
      answer,
      speechPreview,
      queueRemaining,
      evaluations,
      recentAttempts,
      messages,
      isPreviousExpanded,
      expandedPreviousAnswerIds: new Set(expandedPreviousAnswerIds),
      selectedQuestionId,
      selectedQuestion,
      currentUser,
      hasLoadedQuestion: hasLoadedQuestionRef.current,
    };
  }, [
    answer,
    currentQuestionId,
    currentSessionItem,
    currentUser,
    evaluations,
    expandedPreviousAnswerIds,
    isPreviousExpanded,
    messages,
    question,
    queueRemaining,
    recentAttempts,
    selectedQuestionId,
    selectedQuestion,
    sessionQueue,
    speechPreview,
  ]);

  const selectQuestion = useCallback(
    (nextQuestion: string | null, nextQuestionId: string | null = null) => {
      setSelectedQuestion(nextQuestion);
      setSelectedQuestionId(nextQuestion ? nextQuestionId : null);
    },
    [],
  );
  const selectedQuestionAttemptKey = useMemo(
    () =>
      selectedQuestion
        ? questionAttemptCacheKey({
            questionId: selectedQuestionId,
            question: selectedQuestion,
          })
        : null,
    [selectedQuestion, selectedQuestionId],
  );

  useEffect(() => {
    if (!selectedQuestion || !selectedQuestionAttemptKey) {
      return;
    }

    const attemptKey = selectedQuestionAttemptKey;

    if (
      Object.prototype.hasOwnProperty.call(
        questionAttemptsByKey,
        attemptKey,
      ) ||
      questionAttemptsRequestKeysRef.current.has(attemptKey)
    ) {
      return;
    }

    let isActive = true;
    const params = new URLSearchParams();

    if (selectedQuestionId) {
      params.set("questionId", selectedQuestionId);
    } else {
      params.set("question", selectedQuestion);
    }

    questionAttemptsRequestKeysRef.current.add(attemptKey);

    async function loadQuestionAttempts() {
      try {
        const response = await fetch(`/api/question-attempts?${params.toString()}`, {
          cache: "no-store",
        });

        const data = await readJsonResponse<QuestionAttemptsResponse>(
          response,
          "Failed to load question attempts.",
        );

        if (!isActive) {
          return;
        }

        setQuestionAttemptsByKey((current) =>
          Object.prototype.hasOwnProperty.call(current, attemptKey)
            ? current
            : {
                ...current,
                [attemptKey]: data.attempts,
              },
        );
      } catch {
        // Attempt details are loaded on demand; the stats shell remains useful.
      } finally {
        questionAttemptsRequestKeysRef.current.delete(attemptKey);
      }
    }

    void loadQuestionAttempts();

    return () => {
      isActive = false;
    };
  }, [
    questionAttemptsByKey,
    selectedQuestion,
    selectedQuestionAttemptKey,
    selectedQuestionId,
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
    if (cachedSessionRef.current?.currentUser) {
      return;
    }

    if (!hasLoadedQuestionRef.current) {
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

        const data = (await response.json()) as UserProfile;

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
  }, [question]);

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
    function openLocalSettings() {
      setIsSettingsOpen(true);
    }

    window.addEventListener(localSettingsEvent, openLocalSettings);

    return () =>
      window.removeEventListener(localSettingsEvent, openLocalSettings);
  }, []);

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
    setCurrentSessionItem(null);
    setCurrentQuestionId(data.questionId);
    questionIdRef.current = data.questionId;
    setQuestion(data.question);
    questionRef.current = data.question;
    setQueueRemaining(data.queueRemaining);
    setToolbarDueCount(data.queueRemaining);

    if (data.question && options?.appendToMessages !== false) {
      appendQuestion(data.question);
    }
  }, [appendQuestion]);

  const applyReviewQueueItem = useCallback((
    item: ReviewQueueItem | null,
    options?: { appendToMessages?: boolean },
  ) => {
    hasLoadedQuestionRef.current = true;
    setCurrentSessionItem(item);
    currentSessionItemRef.current = item;
    setCurrentQuestionId(item?.questionId ?? null);
    questionIdRef.current = item?.questionId ?? null;
    setQuestion(item?.question ?? null);
    questionRef.current = item?.question ?? null;

    if (item?.question && options?.appendToMessages !== false) {
      appendQuestion(item.question);
    }
  }, [appendQuestion]);

  const loadReviewSessionLookahead = useCallback((anchorItem: ReviewQueueItem) => {
    if (isReviewSessionBackgroundLoadingRef.current) {
      return;
    }

    const currentQueue = sessionQueueRef.current;
    const lookaheadLimit = REVIEW_SESSION_LOOKAHEAD_LIMIT - currentQueue.length;

    if (lookaheadLimit <= 0) {
      return;
    }

    const reloadGeneration = reviewSessionReloadGenerationRef.current;

    isReviewSessionBackgroundLoadingRef.current = true;

    const excludeQuestionIds = [
      anchorItem,
      ...currentQueue,
      ...deferredRetryItemsRef.current,
    ]
      .map((item) => item.questionId)
      .filter((questionId): questionId is string => Boolean(questionId));

    void fetchReviewSessionQueue({
      excludeQuestionIds,
      limit: lookaheadLimit,
    })
      .then((items) => {
        if (reviewSessionReloadGenerationRef.current !== reloadGeneration) {
          return;
        }

        const currentItem = currentSessionItemRef.current;
        const seenKeys = new Set<string>();
        const nextQueue: ReviewQueueItem[] = [];

        for (const item of [...sessionQueueRef.current, ...items]) {
          if (
            currentItem &&
            ((item.questionId && item.questionId === currentItem.questionId) ||
              item.question === currentItem.question)
          ) {
            continue;
          }

          const itemKey = reviewSessionItemKey(item);

          if (seenKeys.has(itemKey)) {
            continue;
          }

          seenKeys.add(itemKey);
          nextQueue.push(item);
        }

        sessionQueueRef.current = nextQueue;
        setSessionQueue(nextQueue);
      })
      .catch(() => {
        // The critical review card is already usable; later advances can refetch.
      })
      .finally(() => {
        isReviewSessionBackgroundLoadingRef.current = false;
      });
  }, []);

  const advanceReviewSessionQueue = useCallback(async (options?: {
    surfaceError?: boolean;
    appendToMessages?: boolean;
  }) => {
    const surfaceError = options?.surfaceError ?? true;
    const reloadGeneration = reviewSessionReloadGenerationRef.current;
    setIsLoadingQuestion(true);
    setError(null);

    try {
      let queue = sessionQueueRef.current;

      if (queue.length === 0) {
        queue = await fetchReviewSessionQueue({
          excludeQuestionIds: deferredReviewRetryQuestionIds(
            deferredRetryItemsRef.current,
          ),
          limit: REVIEW_SESSION_FIRST_ITEM_LIMIT,
        });
      }

      if (reviewSessionReloadGenerationRef.current !== reloadGeneration) {
        return null;
      }

      const [nextItem, ...remainingItems] = queue;
      let nextQueue = nextItem ? remainingItems : [];

      if (nextItem) {
        const releasedRetries = releaseDeferredReviewRetries({
          currentItem: nextItem,
          queue: nextQueue,
          deferredRetryItems: deferredRetryItemsRef.current,
        });

        nextQueue = releasedRetries.queue;
        deferredRetryItemsRef.current = releasedRetries.deferredRetryItems;
      }

      sessionQueueRef.current = nextQueue;
      setSessionQueue(nextQueue);
      applyReviewQueueItem(nextItem ?? null, {
        appendToMessages: options?.appendToMessages,
      });

      if (
        nextItem &&
        nextQueue.length <= REVIEW_SESSION_LOOKAHEAD_LOW_WATERMARK
      ) {
        loadReviewSessionLookahead(nextItem);
      }

      return nextItem ?? null;
    } catch (loadError) {
      if (surfaceError) {
        surfaceReviewError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load the next question.",
          loadError instanceof Error ? loadError.stack : null,
        );
      }
      return null;
    } finally {
      setIsLoadingQuestion(false);
    }
  }, [applyReviewQueueItem, loadReviewSessionLookahead, surfaceReviewError]);

  const loadNextQuestion = useCallback(async (options?: {
    surfaceError?: boolean;
  }) => {
    const surfaceError = options?.surfaceError ?? true;

    return advanceReviewSessionQueue({
      surfaceError,
      appendToMessages: true,
    });
  }, [advanceReviewSessionQueue]);

  const previousAnswerStatusUrl = useCallback((recentAttemptsLimit: number) => {
    const params = new URLSearchParams({
      recentAttemptsLimit: String(Math.max(0, Math.floor(recentAttemptsLimit))),
    });

    return `/api/review-activity?${params.toString()}`;
  }, []);

  const loadPreviousAnswerStatus = useCallback(async (
    recentAttemptsLimit = COLLAPSED_PREVIOUS_ANSWER_LIMIT,
  ) => {
    try {
      const response = await fetch(previousAnswerStatusUrl(recentAttemptsLimit), {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as QueueStatusResponse;

      setQueueRemaining(data.queueRemaining);
      setToolbarDueCount(data.queueRemaining);
      setEvaluations(data.evaluations);
      setRecentAttempts(data.recentAttempts ?? []);
      hasLoadedPreviousAnswerStatusRef.current = true;
    } catch {
      // Previous answers are supplemental; keep the review loop usable.
    }
  }, [previousAnswerStatusUrl]);

  const loadMorePreviousAnswers = useCallback(async () => {
    if (isLoadingMorePreviousAnswers) {
      return;
    }

    setIsLoadingMorePreviousAnswers(true);
    try {
      await loadPreviousAnswerStatus(EXPANDED_PREVIOUS_ANSWER_LIMIT);
      setIsPreviousExpanded(true);
    } finally {
      setIsLoadingMorePreviousAnswers(false);
    }
  }, [isLoadingMorePreviousAnswers, loadPreviousAnswerStatus]);

  useEffect(() => {
    if (hasLoadedQuestionRef.current) {
      return;
    }

    void loadNextQuestion({ surfaceError: false });
  }, [loadNextQuestion, reviewQueueVersion]);

  useEffect(() => {
    if (!hasLoadedQuestionRef.current) {
      return;
    }

    if (!hasLoadedPreviousAnswerStatusRef.current) {
      void loadPreviousAnswerStatus();
    }
  }, [loadPreviousAnswerStatus, question, reviewQueueVersion]);

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
          message.correctAnswer === evaluation.correctAnswer &&
          message.nextDue === evaluation.nextDue &&
          message.resolvedAt === evaluation.resolvedAt &&
          message.evaluationId === evaluation.id &&
          message.traceId === evaluation.traceId &&
          message.cost === evaluation.cost
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
          correctAnswer: evaluation.correctAnswer,
          nextDue: evaluation.nextDue,
          resolvedAt: evaluation.resolvedAt,
          traceId: evaluation.traceId,
          cost: evaluation.cost,
        };
      });

      return hasChanged ? nextMessages : current;
    });
  }, [evaluations]);

  useEffect(() => {
    for (const evaluation of evaluations) {
      if (
        evaluation.status !== "resolved" ||
        processedEvaluationIdsRef.current.has(evaluation.id)
      ) {
        continue;
      }

      const retryItem = pendingRetryItemsRef.current.get(evaluation.id);

      if (!retryItem) {
        continue;
      }

      processedEvaluationIdsRef.current.add(evaluation.id);
      pendingRetryItemsRef.current.delete(evaluation.id);

      if (evaluation.score === null) {
        continue;
      }

      const resolvedAt = evaluation.resolvedAt ?? Date.now();
      const nextDue = evaluation.nextDue ?? resolvedAt;
      if (nextDue > Date.now()) {
        continue;
      }

      const updatedRetryItem: ReviewQueueItem = {
        ...retryItem,
        nextDue,
        msUntilDue: nextDue - Date.now(),
        status: nextDue <= Date.now() ? "now" : "scheduled",
        reviewHistory: [
          ...retryItem.reviewHistory,
          {
            ts: resolvedAt,
            score: evaluation.score,
          },
        ].slice(-10),
        lastScore: evaluation.score,
        lastAnswer: evaluation.answer,
        lastAnswerSummary: evaluation.answerSummary,
        conciseAnswer: evaluation.correctAnswer ?? retryItem.conciseAnswer,
        lastJustification: evaluation.justification,
      };
      const currentItem: ReviewRetryQuestionIdentity | null =
        currentSessionItemRef.current ??
        (questionRef.current
          ? {
              questionId: questionIdRef.current,
              question: questionRef.current,
            }
          : null);
      const placement = placeReviewRetryQuestion({
        retryItem: updatedRetryItem,
        currentItem,
        queue: sessionQueueRef.current,
      });

      if (placement.deferredRetryItem) {
        deferredRetryItemsRef.current = mergeDeferredReviewRetryItem(
          deferredRetryItemsRef.current,
          placement.deferredRetryItem,
        );
      }

      sessionQueueRef.current = placement.queue;
      setSessionQueue(placement.queue);
    }
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
          correctAnswer: message.correctAnswer,
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

    if (!activeQuestion || isSubmittingRef.current || isFlaggingQuestionRef.current) {
      return false;
    }

    const submittedQuestion = activeQuestion;
    const submittedQuestionId = questionIdRef.current;
    const submittedSessionItem = currentSessionItemRef.current;
    const submittedAnswer = (answerOverride ?? answerRef.current).trim();

    if (!submittedAnswer) {
      return false;
    }

    const submittedAt = Date.now();
    const optimisticEvaluationId = `pending-${submittedAt}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const optimisticMessageId = `answer-${optimisticEvaluationId}`;

    isSubmittingRef.current = true;
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
        correctAnswer: null,
        nextDue: null,
        resolvedAt: null,
        cost: null,
      },
    ]);

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

      if (submittedSessionItem) {
        pendingRetryItemsRef.current.set(data.evaluationId, submittedSessionItem);
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

      await advanceReviewSessionQueue({
        appendToMessages: true,
      });

      return true;
    } catch (submitError) {
      setMessages((current) =>
        current.filter(
          (message) =>
            message.kind !== "answer" ||
            message.evaluationId !== optimisticEvaluationId,
        ),
      );
      setCurrentQuestionId(submittedQuestionId);
      questionIdRef.current = submittedQuestionId;
      setCurrentSessionItem(submittedSessionItem);
      currentSessionItemRef.current = submittedSessionItem;
      setQuestion(submittedQuestion);
      questionRef.current = submittedQuestion;
      setAnswer(submittedAnswer);
      answerRef.current = submittedAnswer;
      surfaceReviewError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit the answer.",
        [
          `Question ID: ${submittedQuestionId ?? "unknown"}`,
          `Question: ${submittedQuestion}`,
          `Answer: ${submittedAnswer}`,
          submitError instanceof Error && submitError.stack
            ? `Stack:\n${submitError.stack}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      return false;
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    advanceReviewSessionQueue,
    clearPendingSpeechCommand,
    surfaceReviewError,
  ]);

  const flagCurrentQuestion = useCallback(async () => {
    clearPendingSpeechCommand();
    const activeQuestion = questionRef.current;
    const activeQuestionId = questionIdRef.current;

    if (
      !activeQuestion ||
      !activeQuestionId ||
      isSubmittingRef.current ||
      isFlaggingQuestionRef.current
    ) {
      return false;
    }

    setIsFlaggingQuestion(true);
    setAnswer("");
    answerRef.current = "";
    setSpeechPreview("");
    setError(null);

    const flagRequest = fetch("/api/flag-question", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        questionId: activeQuestionId,
        question: activeQuestion,
      }),
    }).then((response) =>
      readJsonResponse<NextQuestionResponse>(
        response,
        "Failed to flag the question.",
      ),
    );

    try {
      const data = await flagRequest;
      const nextQueue = sessionQueueRef.current.filter(
        (item) =>
          item.questionId !== activeQuestionId &&
          item.question !== activeQuestion,
      );

      sessionQueueRef.current = nextQueue;
      setSessionQueue(nextQueue);

      if (nextQueue.length > 0) {
        await advanceReviewSessionQueue({ appendToMessages: true });
      } else {
        applyNextQuestion(data);
      }

      return true;
    } catch (flagError) {
      surfaceReviewError(
        flagError instanceof Error
          ? flagError.message
          : "Failed to flag the question.",
        [
          `Question ID: ${activeQuestionId}`,
          `Question: ${activeQuestion}`,
          flagError instanceof Error && flagError.stack
            ? `Stack:\n${flagError.stack}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      return false;
    } finally {
      setIsFlaggingQuestion(false);
    }
  }, [
    advanceReviewSessionQueue,
    applyNextQuestion,
    clearPendingSpeechCommand,
    surfaceReviewError,
  ]);

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

      setAnswer("");
      answerRef.current = "";
      setSpeechPreview("");

      pendingSpeechCommandRef.current = speechCommand;
      pendingSpeechCommandTimerRef.current = setTimeout(() => {
        const commandToRun = pendingSpeechCommandRef.current;

        if (!commandToRun) {
          return;
        }

        clearPendingSpeechCommand();

        void submit(commandToRun.submitAnswer);
      }, SPEECH_COMMAND_SETTLE_MS);
    },
    [
      appendAnswerText,
      clearPendingSpeechCommand,
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
  const isAnswerBlank = displayedAnswer.trim().length === 0;
  const isSpeechActive =
    speechStatus === "starting" ||
    speechStatus === "listening";

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
        | UserProfile
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in data && data.error ? data.error : "Could not update avatar.",
        );
      }

      setCurrentUser(data as UserProfile);
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

  const sessionPreviousAnswers: PreviousAnswerItem[] = messages
    .filter(
      (message): message is Extract<ChatMessage, { kind: "answer" }> =>
        message.kind === "answer",
    )
    .slice()
    .reverse()
    .map((message) => {
      const evaluation = evaluations.find(
        (candidate) => candidate.id === message.evaluationId,
      );
      const timestamp = message.resolvedAt ?? message.submittedAt;

      return {
        id: message.id,
        questionId: message.questionId,
        question: message.question,
        answer: message.answer,
        status: message.status,
        phase: message.phase,
        lastActivityAt: message.lastActivityAt,
        score: message.score,
        justification: message.justification,
        correctAnswer: message.correctAnswer,
        traceId: message.traceId,
        cost: evaluation?.cost ?? message.cost ?? null,
        timestamp,
        nextDue: message.nextDue,
        timeLabel:
          message.status === "grading"
            ? "just now"
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
        !sessionPreviousEvaluationIds.has(evaluation.id) &&
        evaluation.answer !== null,
    )
    .slice()
    .reverse()
    .map((evaluation) => {
      const timestamp = evaluation.resolvedAt ?? evaluation.submittedAt;

      return {
        id: `evaluation-${evaluation.id}`,
        questionId: evaluation.questionId,
        question: evaluation.question,
        answer: evaluation.answer || "(blank)",
        status: evaluation.status,
        phase: evaluation.phase,
        lastActivityAt: evaluation.lastActivityAt,
        score: evaluation.score,
        justification: evaluation.justification,
        correctAnswer: evaluation.correctAnswer,
        traceId: evaluation.traceId,
        cost: evaluation.cost,
        timestamp,
        nextDue: evaluation.nextDue,
        timeLabel:
          evaluation.status === "grading"
            ? "just now"
            : formatRelativeTime(timestamp, currentTime),
      };
    });

  const livePreviousQuestions = new Set([
    ...sessionPreviousAnswers.map((previousItem) => previousItem.question),
    ...evaluationPreviousAnswers.map((previousItem) => previousItem.question),
  ]);
  const reviewHistoryPreviousSources = useMemo(() => {
    const byQuestionKey = new Map<string, ReviewQueueItem>();

    for (const item of [currentSessionItem, ...sessionQueue]) {
      if (!item || item.lastScore === null || item.lastAnswer === null) {
        continue;
      }

      const key = item.questionId || `question:${item.question}`;
      const existing = byQuestionKey.get(key);

      if (
        !existing ||
        (reviewQueueItemPreviousTimestamp(item) ?? 0) >
          (reviewQueueItemPreviousTimestamp(existing) ?? 0)
      ) {
        byQuestionKey.set(key, item);
      }
    }

    return Array.from(byQuestionKey.values());
  }, [currentSessionItem, sessionQueue]);

  const recentAttemptPreviousAnswers: PreviousAnswerItem[] = recentAttempts
    .filter((attempt) => {
      if (
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
      questionId: attempt.questionId,
      question: attempt.question,
      answer: attempt.rawAnswer || "(blank)",
      status: "resolved",
      phase: null,
      lastActivityAt: null,
      score: attempt.score,
      justification: attempt.justification,
      correctAnswer: attempt.correctAnswer,
      traceId: null,
      cost: null,
      timestamp: attempt.resolvedAt || attempt.submittedAt,
      nextDue: null,
      timeLabel: formatRelativeTime(
        attempt.resolvedAt || attempt.submittedAt,
        currentTime,
      ),
    }));
  const recentAttemptQuestions = new Set(
    recentAttemptPreviousAnswers.map((previousItem) => previousItem.question),
  );

  const historicalPreviousAnswers: PreviousAnswerItem[] = reviewHistoryPreviousSources
    .filter(
      (item) =>
        item.lastScore !== null &&
        item.lastAnswer !== null &&
        !livePreviousQuestions.has(item.question) &&
        !recentAttemptQuestions.has(item.question),
    )
    .sort((a, b) => {
      const aTimestamp = reviewQueueItemPreviousTimestamp(a) ?? 0;
      const bTimestamp = reviewQueueItemPreviousTimestamp(b) ?? 0;

      if (aTimestamp !== bTimestamp) {
        return bTimestamp - aTimestamp;
      }

      const aScore = a.lastScore ?? -1;
      const bScore = b.lastScore ?? -1;

      if ((aScore >= 7) !== (bScore >= 7)) {
        return aScore >= 7 ? -1 : 1;
      }

      return b.nextDue - a.nextDue;
    })
    .slice(0, EXPANDED_PREVIOUS_ANSWER_LIMIT)
    .map((item) => {
      const timestamp = reviewQueueItemPreviousTimestamp(item);

      return {
        id: `history-${item.questionId}`,
        questionId: item.questionId,
        question: item.question,
        answer: item.lastAnswer,
        status: "resolved",
        phase: null,
        lastActivityAt: null,
        score: item.lastScore,
        justification:
          item.lastJustification ??
          "Covers the core idea; a few details could be sharper.",
        correctAnswer: item.conciseAnswer,
        traceId: null,
        cost: null,
        timestamp,
        nextDue: item.nextDue,
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
  const canLoadMorePreviousAnswers =
    !isPreviousExpanded &&
    (hasHiddenPreviousAnswers ||
      recentAttempts.length >= COLLAPSED_PREVIOUS_ANSWER_LIMIT ||
      previousAnswers.length >= COLLAPSED_PREVIOUS_ANSWER_LIMIT);
  const isReviewResting = !isLoadingQuestion && !question;
  const hasQuestionSwapLayers = questionSwapLayers.length > 0;
  const renderQuestionSwapLayer = (layer: QuestionSwapLayer) => {
    const isExiting = layer.phase === "exiting";

    return (
      <div
        key={layer.key}
        className={`question-swap-layer question-swap-layer-${layer.phase}`}
        aria-hidden={isExiting ? true : undefined}
      >
        <div className="question-source">
          {!isExiting ? (
            <>
              <IconTooltip label="Question details">
                {(tooltipId) => (
                  <button
                    className="question-details-trigger"
                    type="button"
                    aria-label="View current question details"
                    aria-describedby={tooltipId}
                    onClick={() =>
                      selectQuestion(layer.question, layer.questionId)
                    }
                  >
                    <Info aria-hidden="true" />
                  </button>
                )}
              </IconTooltip>
              <IconTooltip label="Flag question">
                {(tooltipId) => (
                  <button
                    className="question-flag-trigger"
                    type="button"
                    aria-label="Flag current question"
                    aria-describedby={tooltipId}
                    onClick={() => {
                      void flagCurrentQuestion();
                    }}
                    disabled={isSubmitting || isFlaggingQuestion}
                  >
                    <Flag aria-hidden="true" />
                  </button>
                )}
              </IconTooltip>
            </>
          ) : null}
          {layer.conceptSlugs.length > 0 ? (
            <div
              className="question-concept-list library-chip-row"
              aria-label="Question tags"
            >
              {layer.conceptSlugs.map((slug) => (
                <Link
                  className="library-chip library-chip-link"
                  href={libraryTagHref(slug)}
                  key={slug}
                >
                  #{slug}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <MarkdownInline
          as="h2"
          className="question-title"
          text={layer.question}
        />
      </div>
    );
  };
  const scheduledReviewCount = sessionQueue.filter(
    (item) => item.status === "scheduled",
  ).length;
  const nextScheduledReview = sessionQueue.find(
    (item) => item.status === "scheduled",
  );
  const shouldFillPreviousAnswerPlaceholders =
    !isPreviousExpanded &&
    (isLoadingQuestion || visiblePreviousAnswers.length === 0);
  const previousAnswerPlaceholderCount = shouldFillPreviousAnswerPlaceholders
    ? Math.max(
        0,
        COLLAPSED_PREVIOUS_ANSWER_LIMIT - visiblePreviousAnswers.length,
      )
    : 0;
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
      [currentSessionItem, ...sessionQueue]
        .filter((item): item is ReviewQueueItem => item !== null)
        .find((item) => matchesSelectedQuestion(item)) ?? null;
    const recentQuestionAttempts = recentAttempts.filter(
      (attempt) => matchesSelectedQuestion(attempt),
    );
    const lazyQuestionAttempts =
      selectedQuestionAttemptKey === null
        ? []
        : (questionAttemptsByKey[selectedQuestionAttemptKey] ?? []);
    const persistedAttemptsById = new Map<number, QuestionAttempt>();

    for (const attempt of [
      ...(queueItem?.attempts ?? []),
      ...recentQuestionAttempts,
      ...lazyQuestionAttempts,
    ]) {
      persistedAttemptsById.set(attempt.id, attempt);
    }

    const persistedAttempts = Array.from(persistedAttemptsById.values());
    const persistedQuestionId =
      persistedAttempts.find((attempt) => attempt.questionId)?.questionId ??
      null;
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

    for (const attempt of persistedAttempts) {
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
    const lastScore = scores.at(-1) ?? queueItem?.lastScore ?? null;
    const lastReviewedAt = reviewHistory.at(-1)?.ts ?? null;
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
    const directNextDue =
      queueItem?.nextDue ??
      latestResolvedEvaluationWithNextDue?.nextDue ??
      latestAnswerMessageWithNextDue?.nextDue ??
      null;
    const nextDue =
      directNextDue ??
      (lastScore !== null && lastScore < SCHEDULED_SCORE_THRESHOLD
        ? (lastReviewedAt ?? currentTime)
        : null);
    const msUntilDue =
      queueItem?.msUntilDue ?? (nextDue === null ? null : nextDue - currentTime);
    const dueStatus =
      queueItem?.status ??
      (msUntilDue === null ? "unknown" : msUntilDue <= 0 ? "now" : "scheduled");
    const persistedAnswerHistory: AnswerHistoryEntry[] =
      persistedAttempts.map((attempt) => ({
        id: `attempt-${attempt.id}`,
        rawAnswer: attempt.rawAnswer || "(blank)",
        answerSummary: attempt.answerSummary || null,
        correctAnswer: attempt.correctAnswer,
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
          correctAnswer: message.correctAnswer,
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
        correctAnswer: evaluation.correctAnswer,
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
      questionId: queueItem?.questionId ?? selectedQuestionId ?? persistedQuestionId,
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
      lastReviewedAt,
      nextDue,
      msUntilDue,
      dueStatus,
      pendingCount,
      generatedFromQuestion: queueItem?.generatedFromQuestion ?? null,
      questionProvenance: queueItem?.questionProvenance ?? null,
      conciseAnswer: queueItem?.conciseAnswer ?? null,
      lastJustification:
        queueItem?.lastJustification ??
        latestResolvedEvaluation?.justification ??
        null,
      conceptSlugs: queueItem?.conceptSlugs ?? [],
    };
  }, [
    currentTime,
    evaluations,
    messages,
    questionAttemptsByKey,
    recentAttempts,
    currentSessionItem,
    selectedQuestionAttemptKey,
    selectedQuestionId,
    selectedQuestion,
    sessionQueue,
  ]);

  usePageScrollLock(isSettingsOpen || Boolean(selectedQuestionStats));

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

  return (
    <main className={`page ${isPreviousExpanded ? "page-previous-expanded" : ""}`}>
      <section className="review-shell" aria-label="Flashcard learning">
        <ReviewToolbar
          activeTab="review"
          dueCount={toolbarDueCount}
          dueCountSource="review-queue"
          showAdmin={canViewAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onManageAccount={onManageAccount}
          onSignOut={onSignOut}
        />

        <div
          className={`review-stage ${
            !isLoadingQuestion && !question ? "review-stage-resting" : ""
          }`}
          id="review-panel"
          role="tabpanel"
          aria-labelledby="review-tab"
        >
          <section className="question-area" aria-live="polite">
            <div
              className="question-copy"
            >
              {isLoadingQuestion && !hasQuestionSwapLayers ? (
                <h2 className="question-title">Loading next question...</h2>
              ) : hasQuestionSwapLayers ? (
                <div className="question-swap-stack">
                  {questionSwapLayers.map(renderQuestionSwapLayer)}
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
                    No questions are due right now.
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
                    <Link
                      className="resting-primary"
                      href="/learn"
                    >
                      Continue learning
                    </Link>
                    <Link
                      className="resting-secondary"
                      href="/library"
                    >
                      View Library
                    </Link>
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
            <AnswerComposer
              id="answer-input"
              textareaRef={answerInputRef}
              value={displayedAnswer}
              onValueChange={(nextAnswer) => {
                clearPendingSpeechCommand();
                setSpeechPreview("");
                setAnswer(nextAnswer);
                answerRef.current = nextAnswer;
              }}
              onSubmit={handleSubmit}
              onKeyDown={handleAnswerKeyDown}
              placeholder="Type your answer here..."
              ariaLabel="Your answer"
              rows={4}
              autoFocus
              disabled={isSubmitting || isFlaggingQuestion}
              submitDisabled={isSubmitting || isFlaggingQuestion || isAnswerBlank}
              submitAriaLabel="Submit answer"
              submitTooltipLabel="Submit answer"
              secondaryAction={
                <IconTooltip
                  label={
                    isSpeechActive ? "Stop voice answer" : "Start voice answer"
                  }
                >
                  {(tooltipId) => (
                    <ComposerMicButton
                      isActive={isSpeechActive}
                      tooltipId={tooltipId}
                      onClick={isSpeechActive ? stopSpeech : startSpeech}
                      disabled={isSubmitting || isFlaggingQuestion}
                    />
                  )}
                </IconTooltip>
              }
              after={
                speechMessage ? (
                  <p
                    className={`speech-status speech-status-${speechStatus}`}
                    aria-live="polite"
                  >
                    {speechMessage}
                  </p>
                ) : null
              }
            />
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
                const isPendingPreviousAnswer = item.status === "grading";
                const isDetailsExpanded = expandedPreviousAnswerIds.has(item.id);
                const detailId = `previous-answer-details-${index}-${item.id.replace(
                  /[^A-Za-z0-9_-]/g,
                  "-",
                )}`;
                const scheduleLabel = formatPreviousAnswerScheduleLabel(
                  item.nextDue,
                  currentTime,
                );

                return (
                  <PreviousAnswerRow
                    id={item.id}
                    key={item.id}
                    question={item.question}
                    status={item.status}
                    score={item.score}
                    feedback={item.justification}
                    correctAnswer={item.correctAnswer}
                    cost={item.cost}
                    timestamp={item.timestamp}
                    timeLabel={item.timeLabel}
                    questionLabel={
                      isPendingPreviousAnswer ? "Evaluating" : undefined
                    }
                    supportingContent={
                      isPendingPreviousAnswer ? null : undefined
                    }
                    metaContent={isPendingPreviousAnswer ? null : undefined}
                    secondaryMetaContent={
                      scheduleLabel ? (
                        <span className="previous-schedule-label">
                          {scheduleLabel}
                        </span>
                      ) : null
                    }
                    isExpanded={isDetailsExpanded}
                    detailId={detailId}
                    onDetailsClick={() =>
                      selectQuestion(item.question, item.questionId)
                    }
                    onToggle={() => togglePreviousAnswerDetails(item.id)}
                  />
                );
              })}

              {!hasPreviousAnswers &&
              isReviewResting &&
              previousAnswerPlaceholderCount === 0 ? (
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
            {canLoadMorePreviousAnswers ? (
              <button
                className="load-more-answers"
                type="button"
                onClick={() => {
                  void loadMorePreviousAnswers();
                }}
                disabled={isLoadingMorePreviousAnswers}
              >
                {isLoadingMorePreviousAnswers ? "Loading..." : "Load more"}
              </button>
            ) : null}
          </section>
        </div>

      </section>

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
                <p className="stats-modal-question-id">
                  <span>Question ID:</span>
                  <code>{selectedQuestionStats.questionId ?? "Unavailable"}</code>
                </p>
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
              {selectedQuestionStats.conceptSlugs.length > 0 ? (
                <div className="stats-feedback">
                  <span>Concepts</span>
                  <div className="stats-concept-list">
                    {selectedQuestionStats.conceptSlugs.map((slug) => (
                      <Link
                        className="stats-concept-chip stats-concept-chip-link"
                        href={libraryTagHref(slug)}
                        key={slug}
                        onClick={() => selectQuestion(null)}
                      >
                        #{slug}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}
