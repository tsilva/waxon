"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  BookOpen,
  Check,
  ChevronRight,
  Loader2,
  PlusCircle,
  SendHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

type CourseToc = {
  title: string;
  description: string;
  chapters: Array<{
    title: string;
    pages: Array<{
      title: string;
      objective: string;
    }>;
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
  const currentPage = Math.min(
    pageOrdinal(course, course.currentChapterIndex, course.currentPageIndex),
    totalPages,
  );

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

function pageOrdinal(course: Course, chapterIndex: number, pageIndex: number) {
  let ordinal = 0;

  for (let index = 0; index < course.toc.chapters.length; index += 1) {
    if (index < chapterIndex) {
      ordinal += course.toc.chapters[index]?.pages.length ?? 0;
      continue;
    }

    if (index === chapterIndex) {
      ordinal += pageIndex + 1;
      break;
    }
  }

  return ordinal;
}

function isMilestoneComplete(
  course: Course,
  chapterIndex: number,
  pageIndex: number,
) {
  if (course.status === "completed") {
    return true;
  }

  return (
    pageOrdinal(course, chapterIndex, pageIndex) <
    pageOrdinal(course, course.currentChapterIndex, course.currentPageIndex)
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
  const [draftConversationCost, setDraftConversationCost] = useState(0);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [isBooting, setIsBooting] = useState(true);
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
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
    chatEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chatMessages, isStreaming]);

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
    setChatMessages([INITIAL_CHAT_MESSAGE]);
    setTopic("");
    setDraftConversationCost(0);
    setError(null);
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
                  : courses.length
                    ? "learn-chat-layout-picker"
                    : "learn-chat-layout-empty"
              }`}
            >
              {selectedCourse ? (
                <aside className="learn-chat-toc" aria-label="Course outline">
                  <div className="learn-course-context">
                    <p className="learn-kicker">{selectedCourse.title}</p>
                    <button type="button" onClick={startNewCourse}>
                      <PlusCircle aria-hidden="true" />
                      <span>New</span>
                    </button>
                  </div>
                  <nav className="learn-toc" aria-label="Course table of contents">
                    {selectedCourse.toc.chapters.map((chapter, chapterIndex) => (
                      <section className="learn-toc-chapter" key={chapter.title}>
                        <h2>{chapter.title}</h2>
                        <ol>
                          {chapter.pages.map((page, pageIndex) => {
                            const isCurrent =
                              selectedCourse.currentChapterIndex === chapterIndex &&
                              selectedCourse.currentPageIndex === pageIndex &&
                              selectedCourse.status !== "completed";
                            const isDone = isMilestoneComplete(
                              selectedCourse,
                              chapterIndex,
                              pageIndex,
                            );

                            return (
                              <li
                                className={isCurrent ? "learn-toc-current" : ""}
                                key={`${chapterIndex}-${pageIndex}-${page.title}`}
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
                      </section>
                    ))}
                  </nav>
                </aside>
              ) : courses.length ? (
                <aside className="learn-course-picker" aria-label="Courses">
                  <div className="learn-course-picker-heading">
                    <p className="learn-kicker">Courses</p>
                    <button type="button" onClick={startNewCourse}>
                      <PlusCircle aria-hidden="true" />
                      <span>New</span>
                    </button>
                  </div>
                  <div className="learn-course-list">
                    {courses.map((course) => (
                      <button
                        className="learn-course-item"
                        disabled={Boolean(loadingCourseId)}
                        key={course.id}
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
                        <small>
                          {loadingCourseId === course.id
                            ? "Loading"
                            : `${course.generatedPages}/${course.totalPages} generated`}
                        </small>
                      </button>
                    ))}
                  </div>
                </aside>
              ) : null}

              <section
                className="learn-chat-panel"
                aria-label={selectedCourse ? "Learn chat" : "Learn something new"}
              >
                <div className="learn-chat-thread">
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
                  <div ref={chatEndRef} />
                </div>
                {conversationCostLabel ? (
                  <div
                    className="learn-conversation-cost"
                    aria-label={`Conversation cost ${conversationCostLabel}`}
                  >
                    {conversationCostLabel}
                  </div>
                ) : null}
                <form className="learn-chat-composer" onSubmit={submitChatPrompt}>
                  <input
                    id="learn-topic-input"
                    type="text"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder={
                      selectedCourse
                        ? "Answer here"
                        : "Learn convolutional neural networks for vision"
                    }
                    disabled={isStreaming}
                  />
                  <button
                    type="submit"
                    disabled={!topic.trim() || isStreaming}
                    aria-label={isStreaming ? streamingStatus : "Send"}
                    title={isStreaming ? streamingStatus : "Send"}
                  >
                    {isStreaming ? (
                      <Loader2 className="learn-spin-icon" aria-hidden="true" />
                    ) : (
                      <SendHorizontal aria-hidden="true" />
                    )}
                  </button>
                </form>
              </section>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
