"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  BookOpen,
  Loader2,
  PlusCircle,
  Search,
  Settings,
  Square,
  SquareCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import {
  AnswerComposer,
  ComposerMicButton,
} from "@/app/AnswerComposer";
import { MarkdownContent, MarkdownInline } from "@/app/MarkdownContent";
import { PreviousAnswerRow } from "@/app/PreviousAnswerRow";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { isAdminEmail } from "@/app/lib/adminAccess";
import {
  isQuestionEvaluationSnippet,
  parseQuestionEvaluationSnippet,
  type LearnQuestionEvaluationSnippet,
} from "@/app/lib/courseEvaluationSnippet";
import {
  parseCourseMessageMetrics,
  type CourseMessageMetrics,
} from "@/app/lib/courseMessageMetrics";
import { shouldShowCourseChatInterruptedWarning } from "@/app/lib/courseChatTurn";
import { formatFormulaMarkdown } from "@/app/lib/markdownFormulaFormatting";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import {
  getSpeechRecognitionConstructor,
  mergeTranscriptText,
  type SpeechRecognition,
  type SpeechStatus,
} from "@/app/lib/speechRecognition";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";

export type CourseToc = {
  title: string;
  description: string;
  pages: Array<{
    title: string;
    objective: string;
  }>;
};

export type Course = {
  id: string;
  topicPrompt: string;
  title: string;
  description: string;
  toc: CourseToc;
  status: "active" | "completed";
  currentChapterIndex: number;
  currentPageIndex: number;
  totalPages: number;
  generatedPages: number;
  chatMessageCount: number;
  conversationCost: number;
  createdAt: number;
  updatedAt: number;
  chatMessages?: StoredCourseChatMessage[];
};

type StoredCourseChatMessage = {
  id?: string;
  role: "assistant" | "user";
  content: string;
  createdAt?: number;
};

export type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type LearnChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  metrics?: CourseMessageMetrics | null;
  status?: string;
  pendingEvaluation?: boolean;
  interrupted?: boolean;
  createdAt?: number;
};

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: Course[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number;
  initialSelectedCourse?: Course | null;
};

type LearnEvaluationDetails = {
  question: string;
  score: number;
  feedback: string;
  correctAnswer: string | null;
  createdAt?: number;
};

const INITIAL_CHAT_MESSAGE: LearnChatMessage = {
  id: "learn-chat-intro",
  role: "assistant",
  content: "What do you want to learn?",
};

const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD = 48;

const COURSE_UPDATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

const COURSE_UPDATED_TITLE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function chatMessageId() {
  return `learn-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isChatThreadNearBottom(thread: HTMLDivElement): boolean {
  const distanceFromBottom =
    thread.scrollHeight - thread.scrollTop - thread.clientHeight;

  return distanceFromBottom <= CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD;
}

function pendingStatus(message: LearnChatMessage): string {
  return message.status?.trim() || "Thinking...";
}

function LearnQuestionEvaluationCard({
  id,
  snippet,
  metrics,
  fallbackQuestion,
  createdAt,
  isExpanded,
  onToggle,
  onDetailsClick,
}: {
  id: string;
  snippet: LearnQuestionEvaluationSnippet;
  metrics?: CourseMessageMetrics | null;
  fallbackQuestion: string | null;
  createdAt?: number;
  isExpanded: boolean;
  onToggle: () => void;
  onDetailsClick: () => void;
}) {
  const question = snippet.question ?? fallbackQuestion ?? "Course question";
  const detailId = `${id.replace(/[^A-Za-z0-9_-]/g, "-")}-details`;

  return (
    <ol
      className="learn-chat-evaluation-list"
      aria-label={`Question evaluation: ${question}`}
    >
      <PreviousAnswerRow
        id={id}
        question={question}
        status="resolved"
        score={snippet.score}
        feedback={snippet.content}
        correctAnswer={snippet.correctAnswer}
        timestamp={createdAt}
        timeLabel={
          typeof createdAt === "number"
            ? formatCourseUpdatedAt(createdAt)
            : "Just now"
        }
        isExpanded={isExpanded}
        detailId={detailId}
        className="learn-chat-evaluation-row"
        secondaryMetaContent={
          metrics ? <LearnChatMessageMetrics metrics={metrics} /> : null
        }
        onToggle={onToggle}
        onDetailsClick={onDetailsClick}
      />
    </ol>
  );
}

function LearnPendingEvaluationCard({ id }: { id: string }) {
  return (
    <ol
      className="learn-chat-evaluation-list"
      aria-label="Question evaluation pending"
    >
      <PreviousAnswerRow
        id={id}
        question="Answer evaluation"
        questionLabel="Evaluation"
        status="grading"
        score={null}
        feedback={null}
        timeLabel="Checking answer"
        className="learn-chat-evaluation-row"
      />
    </ol>
  );
}

function extractFinalLearnerQuestion(content: string): string | null {
  const text = content.trim();
  const questionEnd = text.lastIndexOf("?");

  if (questionEnd === -1) {
    return null;
  }

  const prefix = text.slice(0, questionEnd + 1);
  const boundary = Math.max(
    prefix.lastIndexOf("\n\n"),
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("! "),
  );
  const question = prefix
    .slice(boundary === -1 ? 0 : boundary + 2)
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*Checkpoint\*\*\s*/iu, "")
    .trim();

  return question || null;
}

function findPreviousLearnerQuestion(
  messages: LearnChatMessage[],
  messageIndex: number,
): string | null {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (
      message?.role !== "assistant" ||
      isQuestionEvaluationSnippet(message.content)
    ) {
      continue;
    }

    const question = extractFinalLearnerQuestion(message.content);

    if (question) {
      return question;
    }
  }

  return null;
}

function courseChatFallbackId(message: StoredCourseChatMessage, index: number) {
  const createdAt =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? message.createdAt
      : "unknown";
  const role = message.role === "assistant" ? "assistant" : "user";

  return `stored-course-chat-${createdAt}-${index}-${role}`;
}

function storedMessageToLearnMessage(
  message: StoredCourseChatMessage,
  index: number,
  messages: StoredCourseChatMessage[] = [message],
): LearnChatMessage {
  const parsedMetrics = parseCourseMessageMetrics(message.content);
  const isEvaluationSnippet =
    message.role === "assistant" &&
    isQuestionEvaluationSnippet(parsedMetrics.content);
  const id =
    typeof message.id === "string" && message.id.trim()
      ? message.id
      : courseChatFallbackId(message, index);

  return {
    id,
    role: message.role,
    content: message.content,
    metrics: parsedMetrics.metrics,
    createdAt: message.createdAt,
    interrupted: shouldShowCourseChatInterruptedWarning({
      role: message.role,
      content: parsedMetrics.content,
      isEvaluationSnippet,
      hasLaterStoredMessage: index < messages.length - 1,
    }),
  };
}

function courseProgressLabel(course: Course): string {
  if (course.status === "completed") {
    return "Completed";
  }

  const totalPages = Math.max(course.totalPages, 1);
  const currentPage = Math.min(course.currentPageIndex + 1, totalPages);

  return `${currentPage} of ${totalPages}`;
}

function formatConversationCost(cost: number): string | null {
  if (!Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cost < 0.01 ? 4 : 2,
    maximumFractionDigits: cost < 0.01 ? 4 : 2,
  }).format(cost);
}

function formatMessagePrice(cost: number | null | undefined): string | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cost < 0.01 ? 4 : 2,
    maximumFractionDigits: cost < 0.01 ? 4 : 2,
  }).format(cost);
}

function formatTokensPerSecond(
  tokensPerSecond: number | null | undefined,
): string | null {
  if (
    tokensPerSecond === null ||
    tokensPerSecond === undefined ||
    !Number.isFinite(tokensPerSecond)
  ) {
    return null;
  }

  return `${tokensPerSecond.toFixed(tokensPerSecond < 10 ? 1 : 0)} tok/s`;
}

function formatContextPercent(
  contextPercent: number | null | undefined,
): string | null {
  if (
    contextPercent === null ||
    contextPercent === undefined ||
    !Number.isFinite(contextPercent) ||
    contextPercent < 0
  ) {
    return null;
  }

  if (contextPercent > 0 && contextPercent < 1) {
    return "<1% ctx";
  }

  return `${Math.min(100, Math.round(contextPercent))}% ctx`;
}

function latestCourseContextPercent(
  messages: LearnChatMessage[],
): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const metrics =
      message?.metrics ?? parseCourseMessageMetrics(message?.content ?? "").metrics;

    if (
      metrics?.contextPercent !== null &&
      metrics?.contextPercent !== undefined &&
      Number.isFinite(metrics.contextPercent)
    ) {
      return metrics.contextPercent;
    }
  }

  return null;
}

function LearnChatMessageMetrics({
  metrics,
}: {
  metrics: CourseMessageMetrics | null | undefined;
}) {
  const price = formatMessagePrice(metrics?.cost);
  const tokensPerSecond = formatTokensPerSecond(metrics?.tokensPerSecond);
  const items = [price, tokensPerSecond].filter(
    (item): item is string => Boolean(item),
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <p
      className="learn-chat-message-metrics"
      aria-label={`Response metrics: ${items.join(", ")}`}
    >
      {price ? <span>{price}</span> : null}
      {tokensPerSecond ? <span>{tokensPerSecond}</span> : null}
    </p>
  );
}

function formatCourseUpdatedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }

  return COURSE_UPDATED_FORMATTER.format(new Date(timestamp));
}

function formatCourseUpdatedTitle(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Unknown";
  }

  return COURSE_UPDATED_TITLE_FORMATTER.format(new Date(timestamp));
}

async function readApiJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as T | null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error?: unknown }).error ?? "Request failed.")
        : "Request failed.";

    throw new Error(message);
  }

  if (!data) {
    throw new Error("Request failed.");
  }

  return data;
}

function isMilestoneComplete(
  course: Course,
  pageIndex: number,
) {
  if (course.status === "completed") {
    return true;
  }

  return pageIndex < course.currentPageIndex;
}

function LearnLoadingPlaceholders() {
  return (
    <div
      className="learn-chat-layout learn-chat-layout-course-list learn-loading-layout"
      role="status"
      aria-label="Loading Learn"
      aria-busy="true"
    >
      <section
        className="learn-course-picker learn-course-picker-full learn-loading-courses"
        aria-hidden="true"
      >
        <div className="learn-course-picker-heading">
          <span className="admin-skeleton-line learn-loading-course-heading" />
        </div>
        <div className="learn-course-toolbar">
          <span className="learn-course-search-shell">
            <span className="admin-skeleton-line learn-loading-course-search" />
          </span>
          <span className="learn-course-create-button learn-loading-course-create" />
        </div>
        <div className="learn-course-list">
          {Array.from({ length: 5 }, (_, index) => (
            <article
              className="learn-course-item learn-course-card learn-loading-course-card"
              key={index}
            >
              <div className="learn-course-open">
                <strong className="admin-skeleton-line learn-loading-course-title" />
                <span className="learn-course-state-panel">
                  <span className="admin-skeleton-line learn-loading-course-meta" />
                  <small className="admin-skeleton-line learn-loading-course-copy" />
                </span>
              </div>
              <span className="kb-skeleton-toggle learn-course-settings-trigger learn-loading-course-action" />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function parseSseEvent(rawEvent: string): { event: string; data: unknown } | null {
  const lines = rawEvent.split("\n");
  const event =
    lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (!event || !data) {
    return null;
  }

  try {
    return { event, data: JSON.parse(data) as unknown };
  } catch {
    return null;
  }
}

function learnCoursePath(courseId: string): string {
  return `/learn/courses/${encodeURIComponent(courseId)}`;
}

function updateLearnHistory(pathname: string, mode: "push" | "replace") {
  if (typeof window === "undefined" || window.location.pathname === pathname) {
    return;
  }

  if (mode === "replace") {
    window.history.replaceState(null, "", pathname);
    return;
  }

  window.history.pushState(null, "", pathname);
}

export default function LearnPageClient({
  initialCourseId,
  initialCoursesArePartial = false,
  initialCourses,
  initialCurrentUser,
  initialDueCount,
  initialSelectedCourse,
}: LearnPageClientProps = {}) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const isLocalAuth = isLocalTestAuthEnabled();
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const [topic, setTopic] = useState("");
  const [chatMessages, setChatMessages] = useState<LearnChatMessage[]>(() =>
    initialSelectedCourse?.chatMessages?.length
      ? initialSelectedCourse.chatMessages.map(storedMessageToLearnMessage)
      : [INITIAL_CHAT_MESSAGE],
  );
  const [expandedLearnEvaluationIds, setExpandedLearnEvaluationIds] = useState<
    Set<string>
  >(() => new Set());
  const [courses, setCourses] = useState<Course[]>(() => initialCourses ?? []);
  const [courseSearchQuery, setCourseSearchQuery] = useState("");
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(
    initialSelectedCourse ?? null,
  );
  const [draftCourseToc, setDraftCourseToc] = useState<CourseToc | null>(null);
  const [isStartingNewCourse, setIsStartingNewCourse] = useState(false);
  const [draftConversationCost, setDraftConversationCost] = useState(0);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(
    initialCurrentUser ?? null,
  );
  const [dueCount, setDueCount] = useState(initialDueCount ?? 0);
  const [isBooting, setIsBooting] = useState(!initialCourses);
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courseSettingsId, setCourseSettingsId] = useState<string | null>(null);
  const [selectedEvaluationDetails, setSelectedEvaluationDetails] =
    useState<LearnEvaluationDetails | null>(null);
  const [isDeletingCourse, setIsDeletingCourse] = useState(false);
  const [courseSettingsMessage, setCourseSettingsMessage] =
    useState<string | null>(null);
  const [speechPreview, setSpeechPreview] = useState("");
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollChatRef = useRef(true);
  const touchScrollStartYRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const keepListeningRef = useRef(false);
  const canViewAdmin = isAdminEmail(currentUser?.email);
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    currentUser?.displayName ||
    clerkUser?.username ||
    "Waxon user";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";
  const streamingStatus =
    chatMessages.find(
      (message) => message.role === "assistant" && !message.content,
    )?.status ?? "Thinking...";
  const displayedTopic =
    selectedCourse && speechPreview
      ? mergeTranscriptText(topic, speechPreview)
      : topic;
  const isSpeechActive =
    speechStatus === "starting" || speechStatus === "listening";
  const conversationCostLabel = formatConversationCost(
    selectedCourse?.conversationCost ?? draftConversationCost,
  );
  const conversationContextLabel = formatContextPercent(
    latestCourseContextPercent(chatMessages),
  );
  const conversationMetricItems = [
    conversationCostLabel,
    conversationContextLabel,
  ].filter((item): item is string => Boolean(item));
  const courseSettingsCourse = useMemo(
    () => courses.find((course) => course.id === courseSettingsId) ?? null,
    [courseSettingsId, courses],
  );

  usePageScrollLock(Boolean(courseSettingsCourse || selectedEvaluationDetails));

  const syncCourse = useCallback((course: Course) => {
    setCourses((items) => {
      const existing = items.filter((item) => item.id !== course.id);

      return [course, ...existing].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
    });
  }, []);

  const applySelectedCourse = useCallback((course: Course) => {
    shouldAutoScrollChatRef.current = true;
    setSelectedCourse(course);
    setDraftCourseToc(null);
    setIsStartingNewCourse(false);
    setExpandedLearnEvaluationIds(new Set());
    syncCourse(course);
    setChatMessages(
      course.chatMessages?.length
        ? course.chatMessages.map(storedMessageToLearnMessage)
        : [INITIAL_CHAT_MESSAGE],
    );
    setTopic("");
  }, [syncCourse]);

  useEffect(() => {
    if (initialCourses) {
      setIsBooting(false);
    }

    let isCancelled = false;

    async function boot() {
      try {
        const shouldFetchCourses = !initialCourses || initialCoursesArePartial;
        const courseResponsePromise = initialCourseId && !initialSelectedCourse
          ? fetch(`/api/courses/${encodeURIComponent(initialCourseId)}`, {
              cache: "no-store",
            })
          : Promise.resolve(null);
        const coursesResponsePromise = shouldFetchCourses
          ? fetch("/api/courses", { cache: "no-store" })
          : Promise.resolve(null);
        const [userResponse, queueResponse, coursesResponse, courseResponse] =
          await Promise.all([
            fetch("/api/user", { cache: "no-store" }),
            fetch(
              "/api/queue-status?mode=review&includeReviewQueue=0&includeRecentAttempts=0&includeQuestionAttempts=0&includeKnowledgeEmbeddingPlot=0&includeQueueCounts=1",
              { cache: "no-store" },
            ),
            coursesResponsePromise,
            courseResponsePromise,
          ]);
        const userData = await readApiJson<UserProfile>(userResponse);
        const queueData = (await readApiJson<{ queueRemaining?: number }>(
          queueResponse,
        )) as { queueRemaining?: number };
        const coursesData = coursesResponse
          ? await readApiJson<{ courses?: Course[] }>(coursesResponse)
          : null;
        const courseData = courseResponse
          ? await readApiJson<{ course: Course }>(courseResponse)
          : null;

        if (isCancelled) {
          return;
        }

        setCurrentUser(userData);
        setDueCount(queueData.queueRemaining ?? 0);
        if (coursesData) {
          setCourses(coursesData.courses ?? []);
        }
        if (courseData) {
          applySelectedCourse(courseData.course);
        }
      } catch (bootError) {
        if (!isCancelled) {
          setError(
            bootError instanceof Error
              ? bootError.message
              : "Could not load Learn.",
          );
        }
      } finally {
        if (!isCancelled) {
          setIsBooting(false);
        }
      }
    }

    void boot();

    return () => {
      isCancelled = true;
    };
  }, [
    applySelectedCourse,
    initialCourseId,
    initialCourses,
    initialCoursesArePartial,
    initialCurrentUser,
    initialSelectedCourse,
  ]);

  useEffect(() => {
    const thread = chatThreadRef.current;

    if (!thread) {
      return;
    }

    const chatThread = thread;

    function updateAutoScrollFromPosition() {
      shouldAutoScrollChatRef.current = isChatThreadNearBottom(chatThread);
    }

    function handleWheel(event: WheelEvent) {
      if (event.deltaY < 0) {
        shouldAutoScrollChatRef.current = false;
      }
    }

    function handleTouchStart(event: TouchEvent) {
      touchScrollStartYRef.current = event.touches[0]?.clientY ?? null;
    }

    function handleTouchMove(event: TouchEvent) {
      const startY = touchScrollStartYRef.current;
      const currentY = event.touches[0]?.clientY;

      if (
        typeof startY === "number" &&
        typeof currentY === "number" &&
        currentY > startY
      ) {
        shouldAutoScrollChatRef.current = false;
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home"
      ) {
        shouldAutoScrollChatRef.current = false;
      }
    }

    chatThread.addEventListener("scroll", updateAutoScrollFromPosition, {
      passive: true,
    });
    chatThread.addEventListener("wheel", handleWheel, { passive: true });
    chatThread.addEventListener("touchstart", handleTouchStart, { passive: true });
    chatThread.addEventListener("touchmove", handleTouchMove, { passive: true });
    chatThread.addEventListener("keydown", handleKeyDown);

    return () => {
      chatThread.removeEventListener("scroll", updateAutoScrollFromPosition);
      chatThread.removeEventListener("wheel", handleWheel);
      chatThread.removeEventListener("touchstart", handleTouchStart);
      chatThread.removeEventListener("touchmove", handleTouchMove);
      chatThread.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCourse?.id, draftCourseToc, isStartingNewCourse]);

  useEffect(() => {
    const thread = chatThreadRef.current;

    if (!thread || !shouldAutoScrollChatRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior: "smooth",
      });
    });
  }, [chatMessages, isStreaming]);

  useEffect(() => {
    if (!courseSettingsCourse) {
      return;
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !isDeletingCourse) {
        setCourseSettingsId(null);
        setCourseSettingsMessage(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [courseSettingsCourse, isDeletingCourse]);

  useEffect(() => {
    return () => {
      keepListeningRef.current = false;
      recognitionRef.current?.stop();
    };
  }, []);

  function appendAssistantDelta(messageId: string, delta: string) {
    setChatMessages((messages) =>
      messages.map((message) =>
        message.id === messageId
          ? { ...message, content: `${message.content}${delta}` }
          : message,
      ),
    );
  }

  function updateAssistantStatus(messageId: string, status: string) {
    setChatMessages((messages) =>
      messages.map((message) =>
        message.id === messageId ? { ...message, status } : message,
      ),
    );
  }

  function appendSpeechText(text: string) {
    setTopic((current) => mergeTranscriptText(current, text));
  }

  function stopSpeech() {
    keepListeningRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setSpeechPreview("");
    setSpeechMessage(null);
    setSpeechStatus("idle");
  }

  function startSpeech() {
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

      setSpeechPreview(interimTranscript);

      if (finalTranscript) {
        setSpeechPreview("");
        appendSpeechText(finalTranscript);
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
    }
  }

  function insertQuestionEvaluationSnippet(
    assistantMessageId: string,
    content: string,
  ) {
    const parsedSnippet = parseQuestionEvaluationSnippet(content);

    if (!parsedSnippet?.content) {
      return;
    }

    setChatMessages((messages) => {
      const snippetMessageId = `${assistantMessageId}-evaluation`;
      const snippetMessage: LearnChatMessage = {
        id: snippetMessageId,
        role: "assistant",
        content,
      };

      if (messages.some((message) => message.id === snippetMessageId)) {
        return messages.map((message) =>
          message.id === snippetMessageId ? snippetMessage : message,
        );
      }

      const assistantIndex = messages.findIndex(
        (message) => message.id === assistantMessageId,
      );

      if (assistantIndex === -1) {
        return [...messages, snippetMessage];
      }

      return [
        ...messages.slice(0, assistantIndex),
        snippetMessage,
        ...messages.slice(assistantIndex),
      ];
    });
  }

  function insertPendingQuestionEvaluation(assistantMessageId: string) {
    setChatMessages((messages) => {
      const snippetMessageId = `${assistantMessageId}-evaluation`;

      if (messages.some((message) => message.id === snippetMessageId)) {
        return messages;
      }

      const snippetMessage: LearnChatMessage = {
        id: snippetMessageId,
        role: "assistant",
        content: "",
        pendingEvaluation: true,
      };
      const assistantIndex = messages.findIndex(
        (message) => message.id === assistantMessageId,
      );

      if (assistantIndex === -1) {
        return [...messages, snippetMessage];
      }

      return [
        ...messages.slice(0, assistantIndex),
        snippetMessage,
        ...messages.slice(assistantIndex),
      ];
    });
  }

  function removePendingQuestionEvaluation(assistantMessageId: string) {
    const snippetMessageId = `${assistantMessageId}-evaluation`;

    setChatMessages((messages) =>
      messages.filter(
        (message) =>
          message.id !== snippetMessageId || !message.pendingEvaluation,
      ),
    );
  }

  async function selectCourse(courseId: string) {
    if (isStreaming || loadingCourseId) {
      return;
    }

    stopSpeech();
    setError(null);
    setLoadingCourseId(courseId);

    try {
      const response = await fetch(`/api/courses/${courseId}`, {
        cache: "no-store",
      });
      const data = await readApiJson<{ course: Course }>(response);

      applySelectedCourse(data.course);
      updateLearnHistory(learnCoursePath(data.course.id), "push");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load course.",
      );
    } finally {
      setLoadingCourseId(null);
    }
  }

  function startNewCourse() {
    if (isStreaming || loadingCourseId) {
      return;
    }

    shouldAutoScrollChatRef.current = true;
    stopSpeech();
    setSelectedCourse(null);
    setDraftCourseToc(null);
    setIsStartingNewCourse(true);
    setChatMessages([INITIAL_CHAT_MESSAGE]);
    setExpandedLearnEvaluationIds(new Set());
    setTopic("");
    setDraftConversationCost(0);
    setError(null);
    updateLearnHistory("/learn", "push");
  }

  function openCourseSettings(course: Course) {
    if (isStreaming || loadingCourseId) {
      return;
    }

    setCourseSettingsId(course.id);
    setCourseSettingsMessage(null);
  }

  function closeCourseSettings() {
    if (isDeletingCourse) {
      return;
    }

    setCourseSettingsId(null);
    setCourseSettingsMessage(null);
  }

  async function deleteSelectedCourse() {
    const course = courseSettingsCourse;

    if (!course || isDeletingCourse) {
      return;
    }

    setIsDeletingCourse(true);
    setCourseSettingsMessage(null);

    try {
      const response = await fetch(`/api/courses/${course.id}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error)
            : "Could not delete course.",
        );
      }

      setCourses((items) => items.filter((item) => item.id !== course.id));

      if (selectedCourse?.id === course.id) {
        shouldAutoScrollChatRef.current = true;
        setSelectedCourse(null);
        setDraftCourseToc(null);
        setChatMessages([INITIAL_CHAT_MESSAGE]);
        setExpandedLearnEvaluationIds(new Set());
        setDraftConversationCost(0);
        setTopic("");
        updateLearnHistory("/learn", "replace");
      }

      if (loadingCourseId === course.id) {
        setLoadingCourseId(null);
      }

      setCourseSettingsId(null);
    } catch (deleteError) {
      setCourseSettingsMessage(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete course.",
      );
    } finally {
      setIsDeletingCourse(false);
    }
  }

  function toggleLearnEvaluationDetails(messageId: string) {
    setExpandedLearnEvaluationIds((expandedIds) => {
      const nextIds = new Set(expandedIds);

      if (nextIds.has(messageId)) {
        nextIds.delete(messageId);
      } else {
        nextIds.add(messageId);
      }

      return nextIds;
    });
  }

  function openLearnEvaluationDetails(details: LearnEvaluationDetails) {
    setSelectedEvaluationDetails(details);
  }

  function closeLearnEvaluationDetails() {
    setSelectedEvaluationDetails(null);
  }

  async function submitChatPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = displayedTopic.trim();

    if (!content || isStreaming) {
      return;
    }

    const userMessage: LearnChatMessage = {
      id: chatMessageId(),
      role: "user",
      content,
    };
    const assistantMessageId = chatMessageId();
    const assistantMessage: LearnChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      status: "Thinking...",
    };
    const nextMessages = [...chatMessages, userMessage];

    shouldAutoScrollChatRef.current = true;
    setTopic("");
    stopSpeech();
    setError(null);
    setIsStreaming(true);
    setDraftCourseToc(null);
    setChatMessages([...nextMessages, assistantMessage]);

    try {
      const response = await fetch("/api/courses/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: selectedCourse?.id,
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error)
            : "Could not continue Learn chat.",
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedDone = false;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");

        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseEvent(rawEvent);

          if (parsed?.event === "status") {
            const data = parsed.data as { status?: unknown };

            if (typeof data.status === "string" && data.status.trim()) {
              updateAssistantStatus(assistantMessageId, data.status);
            }
          } else if (parsed?.event === "course") {
            const data = parsed.data as { course?: Course };

            if (data.course) {
              setSelectedCourse(data.course);
              setDraftCourseToc(null);
              setIsStartingNewCourse(false);
              syncCourse(data.course);
            }
          } else if (parsed?.event === "toc") {
            const data = parsed.data as { toc?: Partial<CourseToc> };
            const toc = data.toc;

            if (
              toc &&
              typeof toc === "object" &&
              !Array.isArray(toc) &&
              Array.isArray(toc.pages)
            ) {
              setDraftCourseToc({
                title:
                  typeof toc.title === "string" && toc.title.trim()
                    ? toc.title
                    : "Generating TOC",
                description:
                  typeof toc.description === "string" ? toc.description : "",
                pages: toc.pages.flatMap((page) => {
                  if (!page || typeof page !== "object") {
                    return [];
                  }

                  const title =
                    typeof page.title === "string" ? page.title.trim() : "";
                  const objective =
                    typeof page.objective === "string"
                      ? page.objective.trim()
                      : "";

                  return title && objective ? [{ title, objective }] : [];
                }),
              });
            }
          } else if (parsed?.event === "delta") {
            const data = parsed.data as { delta?: unknown };

            if (typeof data.delta === "string") {
              appendAssistantDelta(assistantMessageId, data.delta);
            }
          } else if (parsed?.event === "evaluation_pending") {
            insertPendingQuestionEvaluation(assistantMessageId);
          } else if (parsed?.event === "evaluation") {
            const data = parsed.data as { content?: unknown };

            if (typeof data.content === "string") {
              insertQuestionEvaluationSnippet(
                assistantMessageId,
                data.content,
              );
            }
          } else if (parsed?.event === "evaluation_skipped") {
            removePendingQuestionEvaluation(assistantMessageId);
          } else if (parsed?.event === "error") {
            const data = parsed.data as { error?: unknown };

            throw new Error(
              typeof data.error === "string"
                ? data.error
                : "Could not continue Learn chat.",
            );
          } else if (parsed?.event === "done") {
            const data = parsed.data as {
              course?: Course;
              chatMessages?: StoredCourseChatMessage[];
              turnCost?: unknown;
              responseMetrics?: CourseMessageMetrics | null;
            };

            if (data.course) {
              if (data.chatMessages?.length) {
                setChatMessages(
                  data.chatMessages.map(storedMessageToLearnMessage),
                );
              }

              setSelectedCourse(data.course);
              setDraftCourseToc(null);
              setIsStartingNewCourse(false);
              syncCourse(data.course);

              if (selectedCourse?.id !== data.course.id) {
                updateLearnHistory(learnCoursePath(data.course.id), "replace");
              }
            } else if (
              typeof data.turnCost === "number" ||
              data.responseMetrics
            ) {
              const turnCost =
                typeof data.turnCost === "number" ? data.turnCost : 0;

              if (turnCost > 0) {
                setDraftConversationCost((cost) => cost + turnCost);
              }
              if (data.responseMetrics) {
                setChatMessages((messages) =>
                  messages.map((message) =>
                    message.id === assistantMessageId
                      ? { ...message, metrics: data.responseMetrics }
                      : message,
                  ),
                );
              }
            } else if (data.chatMessages?.length) {
              setChatMessages(
                data.chatMessages.map(storedMessageToLearnMessage),
              );
            }

            receivedDone = true;
            void reader.cancel().catch(() => undefined);
            break;
          }

          boundary = buffer.indexOf("\n\n");
        }

        if (receivedDone) {
          break;
        }
      }
    } catch (chatError) {
      setError(
        chatError instanceof Error
          ? chatError.message
          : "Could not continue Learn chat.",
      );
      setChatMessages((messages) =>
        messages.filter(
          (message) =>
            message.id !== assistantMessageId &&
            message.id !== `${assistantMessageId}-evaluation`,
        ),
      );
      setDraftCourseToc(null);
    } finally {
      setIsStreaming(false);
    }
  }

  function handleChatComposerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const showCourseList =
    !selectedCourse &&
    !draftCourseToc &&
    courses.length > 0 &&
    !isStartingNewCourse;
  const visibleCourseToc = draftCourseToc ?? selectedCourse?.toc;
  const visibleCourseTitle =
    draftCourseToc?.title ?? selectedCourse?.title ?? "Generating TOC";
  const sortedCourses = useMemo(
    () =>
      [...courses].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.title.localeCompare(right.title),
      ),
    [courses],
  );
  const filteredCourses = useMemo(() => {
    const normalizedQuery = courseSearchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return sortedCourses;
    }

    return sortedCourses.filter((course) =>
      [
        course.title,
        course.description,
        course.topicPrompt,
        course.toc.title,
        course.toc.description,
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [courseSearchQuery, sortedCourses]);

  return (
    <main className="page page-learn-active">
      <section className="review-shell learn-shell" aria-label="Course learning">
        <ReviewToolbar
          activeTab="learn"
          dueCount={dueCount}
          showAdmin={canViewAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onManageAccount={() => {
            if (isLocalAuth) {
              window.location.assign("/review");
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

        <section
          className="learn-stage"
          id="learn-panel"
          role="tabpanel"
          aria-labelledby="learn-tab"
        >
          {error ? (
            <p className="error-message learn-error" role="alert">
              {error}
            </p>
          ) : null}

          {isBooting ? <LearnLoadingPlaceholders /> : null}

          {!isBooting ? (
            <div
              className={`learn-chat-layout ${
                selectedCourse || draftCourseToc
                  ? ""
                  : showCourseList
                    ? "learn-chat-layout-course-list"
                    : "learn-chat-layout-empty"
              }`}
            >
              {visibleCourseToc ? (
                <aside
                  className="learn-chat-toc"
                  aria-label="Course outline"
                  aria-live={selectedCourse ? undefined : "polite"}
                >
                  <p className="learn-kicker">{visibleCourseTitle}</p>
                  <nav className="learn-toc" aria-label="Course table of contents">
                    <ol>
                      {visibleCourseToc.pages.map((page, pageIndex) => {
                        const isCurrent =
                          selectedCourse
                            ? selectedCourse.currentPageIndex === pageIndex &&
                              selectedCourse.status !== "completed"
                            : pageIndex === 0;
                        const isDone = selectedCourse
                          ? isMilestoneComplete(selectedCourse, pageIndex)
                          : false;

                        return (
                          <li
                            className={[
                              isCurrent ? "learn-toc-current" : "",
                              isDone ? "learn-toc-complete" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            key={`${pageIndex}-${page.title}`}
                          >
                            <span className="learn-toc-status">
                              {isDone ? (
                                <SquareCheck aria-hidden="true" />
                              ) : (
                                <Square aria-hidden="true" />
                              )}
                            </span>
                            <p>{page.title}</p>
                          </li>
                        );
                      })}
                      {!selectedCourse ? (
                        <li className="learn-toc-streaming">
                          <span className="learn-toc-status">
                            <span
                              className="pending-spinner"
                              aria-hidden="true"
                            />
                          </span>
                          <p>Generating TOC</p>
                        </li>
                      ) : null}
                    </ol>
                  </nav>
                </aside>
              ) : showCourseList ? (
                <section
                  className="learn-course-picker learn-course-picker-full"
                  aria-label="Courses"
                >
                  <div className="learn-course-toolbar">
                    <label className="learn-course-search-shell">
                      <Search aria-hidden="true" />
                      <span className="sr-only">Search courses</span>
                      <input
                        className="learn-course-search-input"
                        type="search"
                        value={courseSearchQuery}
                        onChange={(event) =>
                          setCourseSearchQuery(event.target.value)
                        }
                        placeholder="Search courses"
                      />
                    </label>
                    <button
                      className="learn-course-create-button"
                      disabled={Boolean(loadingCourseId)}
                      type="button"
                      onClick={startNewCourse}
                    >
                      <PlusCircle aria-hidden="true" />
                      Create
                    </button>
                  </div>
                  <div className="learn-course-list">
                    {filteredCourses.length === 0 ? (
                      <p className="learn-course-empty">No matching courses.</p>
                    ) : null}
                    {filteredCourses.map((course) => (
                      <article
                        className="learn-course-item learn-course-card"
                        key={course.id}
                      >
                        <button
                          className="learn-course-open"
                          disabled={Boolean(loadingCourseId)}
                          type="button"
                          onClick={() => {
                            void selectCourse(course.id);
                          }}
                        >
                          <strong>{course.title}</strong>
                          <span className="learn-course-state-panel">
                            <span className="learn-course-progress">
                              <BookOpen aria-hidden="true" />
                              {courseProgressLabel(course)}
                            </span>
                            <small className="learn-course-meta">
                              {loadingCourseId === course.id
                                ? "Loading"
                                : `${course.generatedPages}/${course.totalPages} generated`}
                              {" / "}
                              <time
                                className="learn-course-updated"
                                dateTime={new Date(course.updatedAt).toISOString()}
                                title={formatCourseUpdatedTitle(course.updatedAt)}
                              >
                                Updated {formatCourseUpdatedAt(course.updatedAt)}
                              </time>
                            </small>
                          </span>
                        </button>
                        <button
                          className="learn-course-settings-trigger"
                          disabled={Boolean(loadingCourseId)}
                          type="button"
                          aria-label={`Open ${course.title} settings`}
                          onClick={() => openCourseSettings(course)}
                        >
                          <Settings aria-hidden="true" />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {!showCourseList ? (
                <section
                  className="learn-chat-panel"
                  aria-label={
                    selectedCourse ? "Learn chat" : "Learn something new"
                  }
                >
                  <div className="learn-chat-thread" ref={chatThreadRef}>
                    {chatMessages.map((message, messageIndex) => {
                      if (message.pendingEvaluation) {
                        return (
                          <LearnPendingEvaluationCard
                            key={message.id}
                            id={message.id}
                          />
                        );
                      }

                      const parsedMessage = parseCourseMessageMetrics(
                        message.content,
                      );
                      const visibleMessageContent = parsedMessage.content;
                      const messageMetrics =
                        message.metrics ?? parsedMessage.metrics;
                      const evaluationSnippet =
                        message.role === "assistant"
                          ? parseQuestionEvaluationSnippet(
                              visibleMessageContent,
                            )
                          : null;
                      const messageContent =
                        evaluationSnippet?.content ?? visibleMessageContent;
                      if (evaluationSnippet) {
                        const fallbackQuestion = findPreviousLearnerQuestion(
                          chatMessages,
                          messageIndex,
                        );
                        const evaluationQuestion =
                          evaluationSnippet.question ??
                          fallbackQuestion ??
                          "Course question";

                        return (
                          <LearnQuestionEvaluationCard
                            key={message.id}
                            id={message.id}
                            snippet={evaluationSnippet}
                            metrics={messageMetrics}
                            fallbackQuestion={fallbackQuestion}
                            createdAt={message.createdAt}
                            isExpanded={expandedLearnEvaluationIds.has(
                              message.id,
                            )}
                            onToggle={() =>
                              toggleLearnEvaluationDetails(message.id)
                            }
                            onDetailsClick={() =>
                              openLearnEvaluationDetails({
                                question: evaluationQuestion,
                                score: evaluationSnippet.score,
                                feedback: evaluationSnippet.content,
                                correctAnswer: evaluationSnippet.correctAnswer,
                                createdAt: message.createdAt,
                              })
                            }
                          />
                        );
                      }

                      const messageKind = evaluationSnippet
                        ? "evaluation"
                        : message.role;

                      return (
                        <div
                          className={`learn-chat-message learn-chat-message-${message.role} learn-chat-message-${messageKind}`}
                          key={message.id}
                        >
                          {messageContent ? (
                            <div className="learn-chat-message-stack">
                              <MarkdownContent
                                className={`learn-chat-message-content learn-chat-message-content-${messageKind}`}
                                text={messageContent}
                                enableCodeBlocks
                                enableHeadings={
                                  message.role === "assistant" &&
                                  !evaluationSnippet
                                }
                                enableMath={message.role === "assistant"}
                              />
                              {message.interrupted ? (
                                <p
                                  className="learn-chat-interrupted"
                                  role="status"
                                >
                                  This tutor message was interrupted before the
                                  final question finished.
                                </p>
                              ) : null}
                              <LearnChatMessageMetrics
                                metrics={messageMetrics}
                              />
                            </div>
                          ) : (
                            <span
                              className="learn-chat-pending"
                              role="status"
                              aria-live="polite"
                            >
                              <span className="learn-chat-pending-status">
                                {pendingStatus(message)}
                              </span>
                              <span className="progress-dot-suffix" aria-hidden="true">
                                <span />
                                <span />
                                <span />
                              </span>
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <div className="learn-chat-end" />
                  </div>
                  <AnswerComposer
                    id="learn-topic-input"
                    className="learn-course-answer-composer"
                    value={selectedCourse ? displayedTopic : topic}
                    onValueChange={(nextTopic) => {
                      setSpeechPreview("");
                      setTopic(nextTopic);
                    }}
                    onSubmit={submitChatPrompt}
                    onKeyDown={handleChatComposerKeyDown}
                    placeholder={
                      selectedCourse
                        ? "Type your answer here..."
                        : "Learn convolutional neural networks for vision"
                    }
                    ariaLabel={selectedCourse ? "Answer here" : "Learning goal"}
                    rows={4}
                    disabled={isStreaming}
                    submitDisabled={!topic.trim() || isStreaming}
                    submitAriaLabel={isStreaming ? streamingStatus : "Send"}
                    submitTitle={isStreaming ? streamingStatus : "Send"}
                    submitIcon={
                      isStreaming ? (
                        <Loader2 className="learn-spin-icon" aria-hidden="true" />
                      ) : undefined
                    }
                    secondaryAction={
                      selectedCourse ? (
                        <ComposerMicButton
                          isActive={isSpeechActive}
                          onClick={isSpeechActive ? stopSpeech : startSpeech}
                          disabled={isStreaming}
                        />
                      ) : undefined
                    }
                    after={
                      selectedCourse &&
                      (speechMessage || conversationMetricItems.length > 0) ? (
                        <>
                          {conversationMetricItems.length > 0 ? (
                            <div
                              className="learn-conversation-cost"
                              aria-label={`Conversation metrics: ${conversationMetricItems.join(", ")}`}
                            >
                              {conversationMetricItems.join(" / ")}
                            </div>
                          ) : null}
                          {speechMessage ? (
                            <p
                              className={`speech-status speech-status-${speechStatus}`}
                              aria-live="polite"
                            >
                              {speechMessage}
                            </p>
                          ) : null}
                        </>
                      ) : null
                    }
                  />
                </section>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>

      {courseSettingsCourse ? (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCourseSettings();
            }
          }}
        >
          <section
            className="settings-modal course-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={isDeletingCourse}
            aria-labelledby="course-settings-title"
          >
            <div className="settings-modal-header">
              <div>
                <p className="settings-modal-kicker">Course settings</p>
                <h2 className="settings-modal-title" id="course-settings-title">
                  {courseSettingsCourse.title}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close course settings"
                disabled={isDeletingCourse}
                onClick={closeCourseSettings}
              />
            </div>

            <dl className="course-settings-summary" aria-label="Course summary">
              <div>
                <dt>{courseSettingsCourse.generatedPages}</dt>
                <dd>generated pages</dd>
              </div>
              <div>
                <dt>{courseSettingsCourse.chatMessageCount}</dt>
                <dd>chat messages</dd>
              </div>
              <div>
                <dt>{formatCourseUpdatedAt(courseSettingsCourse.updatedAt)}</dt>
                <dd>last updated</dd>
              </div>
            </dl>

            <div className="course-settings-danger">
              <div>
                <h3>Delete course</h3>
                <p>
                  This removes the course, its chat, generated pages, page
                  attempts, and generated review questions.
                </p>
              </div>
              <button
                className="course-delete-action"
                type="button"
                disabled={isDeletingCourse}
                onClick={() => {
                  void deleteSelectedCourse();
                }}
              >
                <Trash2 aria-hidden="true" />
                <span>
                  {isDeletingCourse ? "Deleting..." : "Delete course and data"}
                </span>
              </button>
            </div>

            {courseSettingsMessage ? (
              <p className="kb-editor-status" role="alert">
                {courseSettingsMessage}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {selectedEvaluationDetails ? (
        <div
          className="stats-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeLearnEvaluationDetails();
            }
          }}
        >
          <section
            className="stats-modal learn-evaluation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="learn-evaluation-modal-title"
          >
            <div className="stats-modal-header">
              <div>
                <p className="stats-modal-kicker">Question details</p>
                <div id="learn-evaluation-modal-title">
                  <MarkdownInline
                    as="h2"
                    className="stats-modal-title"
                    text={selectedEvaluationDetails.question}
                  />
                </div>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close question details"
                onClick={closeLearnEvaluationDetails}
              />
            </div>

            <div className="stats-grid" aria-label="Evaluation summary">
              <div className="stats-tile">
                <span>Score</span>
                <strong>{selectedEvaluationDetails.score}/10</strong>
              </div>
              <div className="stats-tile">
                <span>Recorded</span>
                <strong>
                  {typeof selectedEvaluationDetails.createdAt === "number"
                    ? formatCourseUpdatedAt(selectedEvaluationDetails.createdAt)
                    : "Just now"}
                </strong>
              </div>
            </div>

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Feedback</h3>
              </div>
              <MarkdownContent
                className="previous-question-feedback"
                enableMath
                text={selectedEvaluationDetails.feedback}
              />
            </div>

            <div className="stats-history-panel">
              <div className="stats-section-heading">
                <h3>Correct answer</h3>
              </div>
              {selectedEvaluationDetails.correctAnswer ? (
                <MarkdownContent
                  className="previous-answer"
                  enableMath
                  text={formatFormulaMarkdown(
                    selectedEvaluationDetails.correctAnswer,
                    { style: "math" },
                  )}
                />
              ) : (
                <p className="previous-answer previous-answer-empty">
                  No correct answer recorded.
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
