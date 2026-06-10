"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { Check, ChevronRight, Loader2, SendHorizontal } from "lucide-react";
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
};

const INITIAL_CHAT_MESSAGE: LearnChatMessage = {
  id: "learn-chat-intro",
  role: "assistant",
  content: "What do you want to learn?",
};

function chatMessageId() {
  return `learn-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [isBooting, setIsBooting] = useState(true);
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

  useEffect(() => {
    let isCancelled = false;

    async function boot() {
      try {
        const [userResponse, queueResponse] = await Promise.all([
          fetch("/api/user", { cache: "no-store" }),
          fetch("/api/queue-status?mode=review&includeReviewQueue=0", {
            cache: "no-store",
          }),
        ]);
        const userData = await readApiJson<UserProfile>(userResponse);
        const queueData = (await readApiJson<{ queueRemaining?: number }>(
          queueResponse,
        )) as { queueRemaining?: number };

        if (isCancelled) {
          return;
        }

        setCurrentUser(userData);
        setDueCount(queueData.queueRemaining ?? 0);
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

          if (parsed?.event === "course") {
            const data = parsed.data as { course?: Course };

            if (data.course) {
              setSelectedCourse(data.course);
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
                selectedCourse ? "" : "learn-chat-layout-empty"
              }`}
            >
              {selectedCourse ? (
                <aside className="learn-chat-toc" aria-label="Course outline">
                  <p className="learn-kicker">{selectedCourse.title}</p>
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
              ) : null}

              <section className="learn-chat-panel" aria-label="Learn chat">
                <div className="learn-chat-thread">
                  {chatMessages.map((message) => (
                    <div
                      className={`learn-chat-message learn-chat-message-${message.role}`}
                      key={message.id}
                    >
                      {message.content ? (
                        <MarkdownContent
                          className="learn-chat-message-content"
                          text={message.content}
                          enableCodeBlocks
                          enableHeadings={false}
                        />
                      ) : (
                        <span className="pending-spinner" aria-hidden="true" />
                      )}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
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
                    aria-label="Send"
                    title="Send"
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
