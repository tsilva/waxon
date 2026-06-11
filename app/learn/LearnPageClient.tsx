"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  BookOpen,
  Check,
  ChevronRight,
  Loader2,
  PlusCircle,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { AnswerComposer } from "@/app/AnswerComposer";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";

type CourseToc = {
  title: string;
  description: string;
  pages: Array<{
    title: string;
    objective: string;
  }>;
};

type Course = {
  id: string;
  deckName: string;
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
  id: string;
  role: "assistant" | "user";
  content: string;
};

type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type LearnChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  status?: string;
};

const INITIAL_CHAT_MESSAGE: LearnChatMessage = {
  id: "learn-chat-intro",
  role: "assistant",
  content: "What do you want to learn?",
};

const COURSE_UPDATED_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const COURSE_UPDATED_TITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function chatMessageId() {
  return `learn-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pendingStatus(message: LearnChatMessage): string {
  return message.status?.trim() || "Thinking...";
}

function storedMessageToLearnMessage(
  message: StoredCourseChatMessage,
): LearnChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
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

export default function LearnPageClient() {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const isLocalAuth = isLocalTestAuthEnabled();
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const [topic, setTopic] = useState("");
  const [chatMessages, setChatMessages] = useState<LearnChatMessage[]>([
    INITIAL_CHAT_MESSAGE,
  ]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [isStartingNewCourse, setIsStartingNewCourse] = useState(false);
  const [draftConversationCost, setDraftConversationCost] = useState(0);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [isBooting, setIsBooting] = useState(true);
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courseSettingsId, setCourseSettingsId] = useState<string | null>(null);
  const [isDeletingCourse, setIsDeletingCourse] = useState(false);
  const [courseSettingsMessage, setCourseSettingsMessage] =
    useState<string | null>(null);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
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
  const conversationCostLabel = formatConversationCost(
    selectedCourse?.conversationCost ?? draftConversationCost,
  );
  const courseSettingsCourse = useMemo(
    () => courses.find((course) => course.id === courseSettingsId) ?? null,
    [courseSettingsId, courses],
  );

  usePageScrollLock(Boolean(courseSettingsCourse));

  useEffect(() => {
    let isCancelled = false;

    async function boot() {
      try {
        const [userResponse, queueResponse, coursesResponse] =
          await Promise.all([
            fetch("/api/user", { cache: "no-store" }),
            fetch("/api/queue-status?mode=review&includeReviewQueue=0", {
              cache: "no-store",
            }),
            fetch("/api/courses", { cache: "no-store" }),
          ]);
        const userData = await readApiJson<UserProfile>(userResponse);
        const queueData = (await readApiJson<{ queueRemaining?: number }>(
          queueResponse,
        )) as { queueRemaining?: number };
        const coursesData = await readApiJson<{ courses?: Course[] }>(
          coursesResponse,
        );

        if (isCancelled) {
          return;
        }

        setCurrentUser(userData);
        setDueCount(queueData.queueRemaining ?? 0);
        setCourses(coursesData.courses ?? []);
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
  }, []);

  useEffect(() => {
    const thread = chatThreadRef.current;

    if (!thread) {
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

  function syncCourse(course: Course) {
    setCourses((items) => {
      const existing = items.filter((item) => item.id !== course.id);

      return [course, ...existing].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
    });
  }

  async function selectCourse(courseId: string) {
    if (isStreaming || loadingCourseId) {
      return;
    }

    setError(null);
    setLoadingCourseId(courseId);

    try {
      const response = await fetch(`/api/courses/${courseId}`, {
        cache: "no-store",
      });
      const data = await readApiJson<{ course: Course }>(response);

      setSelectedCourse(data.course);
      setIsStartingNewCourse(false);
      syncCourse(data.course);
      setChatMessages(
        data.course.chatMessages?.length
          ? data.course.chatMessages.map(storedMessageToLearnMessage)
          : [INITIAL_CHAT_MESSAGE],
      );
      setTopic("");
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

    setSelectedCourse(null);
    setIsStartingNewCourse(true);
    setChatMessages([INITIAL_CHAT_MESSAGE]);
    setTopic("");
    setDraftConversationCost(0);
    setError(null);
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
        setSelectedCourse(null);
        setChatMessages([INITIAL_CHAT_MESSAGE]);
        setDraftConversationCost(0);
        setTopic("");
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

  async function submitChatPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = topic.trim();

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

    setTopic("");
    setError(null);
    setIsStreaming(true);
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
              setIsStartingNewCourse(false);
              syncCourse(data.course);
            }
          } else if (parsed?.event === "delta") {
            const data = parsed.data as { delta?: unknown };

            if (typeof data.delta === "string") {
              appendAssistantDelta(assistantMessageId, data.delta);
            }
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
            };

            if (data.course) {
              setSelectedCourse(data.course);
              setIsStartingNewCourse(false);
              syncCourse(data.course);
            } else if (typeof data.turnCost === "number" && data.turnCost > 0) {
              const turnCost = data.turnCost;

              setDraftConversationCost((cost) => cost + turnCost);
            }

            if (data.chatMessages?.length) {
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
        messages.filter((message) => message.id !== assistantMessageId),
      );
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
    !selectedCourse && courses.length > 0 && !isStartingNewCourse;
  const sortedCourses = useMemo(
    () =>
      [...courses].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.title.localeCompare(right.title),
      ),
    [courses],
  );

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

          {isBooting ? (
            <div className="learn-loading" role="status">
              <span className="pending-spinner" aria-hidden="true" />
              <span>Loading Learn</span>
            </div>
          ) : null}

          {!isBooting ? (
            <div
              className={`learn-chat-layout ${
                selectedCourse
                  ? ""
                  : showCourseList
                    ? "learn-chat-layout-course-list"
                    : "learn-chat-layout-empty"
              }`}
            >
              {selectedCourse ? (
                <aside className="learn-chat-toc" aria-label="Course outline">
                  <p className="learn-kicker">{selectedCourse.title}</p>
                  <nav className="learn-toc" aria-label="Course table of contents">
                    <ol>
                      {selectedCourse.toc.pages.map((page, pageIndex) => {
                        const isCurrent =
                          selectedCourse.currentPageIndex === pageIndex &&
                          selectedCourse.status !== "completed";
                        const isDone = isMilestoneComplete(
                          selectedCourse,
                          pageIndex,
                        );

                        return (
                          <li
                            className={isCurrent ? "learn-toc-current" : ""}
                            key={`${pageIndex}-${page.title}`}
                          >
                            <span>
                              {isDone ? (
                                <Check aria-hidden="true" />
                              ) : (
                                <ChevronRight aria-hidden="true" />
                              )}
                            </span>
                            <p>{page.title}</p>
                          </li>
                        );
                      })}
                    </ol>
                  </nav>
                </aside>
              ) : showCourseList ? (
                <section
                  className="learn-course-picker learn-course-picker-full"
                  aria-label="Courses"
                >
                  <div className="learn-course-picker-heading">
                    <p className="learn-kicker">Courses</p>
                  </div>
                  <div className="learn-course-list">
                    <button
                      className="learn-course-item learn-course-new"
                      aria-label="New course"
                      disabled={Boolean(loadingCourseId)}
                      type="button"
                      onClick={startNewCourse}
                    >
                      <span aria-hidden="true">
                        <PlusCircle aria-hidden="true" />
                      </span>
                      <strong>New</strong>
                    </button>
                    {sortedCourses.map((course) => (
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
                          <span>
                            <BookOpen aria-hidden="true" />
                            {courseProgressLabel(course)}
                          </span>
                          <strong>{course.title}</strong>
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
                    {chatMessages.map((message) => (
                      <div
                        className={`learn-chat-message learn-chat-message-${message.role}`}
                        key={message.id}
                      >
                        {message.content ? (
                          <MarkdownContent
                            className={`learn-chat-message-content learn-chat-message-content-${message.role}`}
                            text={message.content}
                            enableCodeBlocks
                            enableHeadings={message.role === "assistant"}
                            enableMath={message.role === "assistant"}
                          />
                        ) : (
                          <span
                            className="learn-chat-pending"
                            role="status"
                            aria-live="polite"
                          >
                            <span className="pending-spinner" aria-hidden="true" />
                            <span className="learn-chat-pending-status">
                              {pendingStatus(message)}
                            </span>
                          </span>
                        )}
                      </div>
                    ))}
                    <div className="learn-chat-end" />
                  </div>
                  {conversationCostLabel ? (
                    <div
                      className="learn-conversation-cost"
                      aria-label={`Conversation cost ${conversationCostLabel}`}
                    >
                      {conversationCostLabel}
                    </div>
                  ) : null}
                  <AnswerComposer
                    id="learn-topic-input"
                    className={
                      selectedCourse
                        ? "learn-course-answer-composer"
                        : "learn-chat-composer"
                    }
                    value={topic}
                    onValueChange={setTopic}
                    onSubmit={submitChatPrompt}
                    onKeyDown={handleChatComposerKeyDown}
                    placeholder={
                      selectedCourse
                        ? "Type your answer here..."
                        : "Learn convolutional neural networks for vision"
                    }
                    ariaLabel={selectedCourse ? "Answer here" : "Learning goal"}
                    rows={selectedCourse ? 4 : 1}
                    disabled={isStreaming}
                    submitDisabled={!topic.trim() || isStreaming}
                    submitAriaLabel={isStreaming ? streamingStatus : "Send"}
                    submitTitle={isStreaming ? streamingStatus : "Send"}
                    submitIcon={
                      isStreaming ? (
                        <Loader2 className="learn-spin-icon" aria-hidden="true" />
                      ) : undefined
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
              <p className="deck-editor-status" role="alert">
                {courseSettingsMessage}
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
