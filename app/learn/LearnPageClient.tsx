"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  BookOpen,
  Check,
  ChevronRight,
  Loader2,
  SendHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { MarkdownContent } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

type CourseChoice = {
  id: string;
  text: string;
};

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

type CoursePage = {
  id: string;
  chapterIndex: number;
  pageIndex: number;
  title: string;
  body: string;
  summary: string;
  question: string;
  choices: CourseChoice[];
  widget?: {
    type: "multiple_choice";
    id: string;
    question: string;
    choices: CourseChoice[];
  };
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
  pages?: CoursePage[];
};

type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type ApiResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      error: string;
    };

type LearnChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

type CourseIntakeDecision =
  | {
      action: "clarify";
      message: string;
    }
  | {
      action: "create_course";
      topic: string;
      message: string;
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

function currentCoursePage(course: Course | null): CoursePage | null {
  if (!course?.pages) {
    return null;
  }

  return (
    course.pages.find(
      (page) =>
        page.chapterIndex === course.currentChapterIndex &&
        page.pageIndex === course.currentPageIndex,
    ) ?? null
  );
}

function multipleChoiceWidget(page: CoursePage) {
  return (
    page.widget ?? {
      type: "multiple_choice",
      id: `${page.id}-multiple-choice`,
      question: page.question,
      choices: page.choices,
    }
  );
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
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [isBooting, setIsBooting] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isIntaking, setIsIntaking] = useState(false);
  const [isGeneratingPage, setIsGeneratingPage] = useState(false);
  const [isAnswering, setIsAnswering] = useState(false);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canViewAdmin = isAdminEmail(currentUser?.email);
  const currentPage = currentCoursePage(selectedCourse);
  const currentPageWidget = currentPage ? multipleChoiceWidget(currentPage) : null;
  const isChatBusy = isIntaking || isCreating;
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    currentUser?.displayName ||
    clerkUser?.username ||
    "Waxon user";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";

  const syncCourse = useCallback((course: Course) => {
    setSelectedCourse(course);
    setCourses((items) => {
      const existingIndex = items.findIndex((item) => item.id === course.id);

      if (existingIndex === -1) {
        return [course, ...items];
      }

      return items.map((item) => (item.id === course.id ? course : item));
    });
  }, []);

  const loadCourse = useCallback(
    async (courseId: string) => {
      const data = await readApiJson<ApiResult<{ course: Course }>>(
        await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
          cache: "no-store",
        }),
      );

      if (!data.ok) {
        throw new Error(data.error);
      }

      syncCourse(data.course);
      return data.course;
    },
    [syncCourse],
  );

  const loadCurrentPage = useCallback(
    async (courseId: string) => {
      setIsGeneratingPage(true);
      setError(null);

      try {
        const data = await readApiJson<
          ApiResult<{ course: Course; page: CoursePage | null }>
        >(
          await fetch(`/api/courses/${encodeURIComponent(courseId)}/next-page`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        );

        if (!data.ok) {
          throw new Error(data.error);
        }

        syncCourse(data.course);
        setFeedback(null);
        setSelectedChoiceId(null);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not generate page.",
        );
      } finally {
        setIsGeneratingPage(false);
      }
    },
    [syncCourse],
  );

  useEffect(() => {
    let isCancelled = false;

    async function boot() {
      try {
        const [userResponse, queueResponse, coursesResponse] = await Promise.all([
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
        const coursesData = await readApiJson<ApiResult<{ courses: Course[] }>>(
          coursesResponse,
        );

        if (isCancelled) {
          return;
        }

        if (!coursesData.ok) {
          throw new Error(coursesData.error);
        }

        setCurrentUser(userData);
        setDueCount(queueData.queueRemaining ?? 0);
        setCourses(coursesData.courses);
        setSelectedCourse(coursesData.courses[0] ?? null);
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
    if (
      !selectedCourse ||
      selectedCourse.status === "completed" ||
      currentCoursePage(selectedCourse) ||
      isGeneratingPage
    ) {
      return;
    }

    void loadCurrentPage(selectedCourse.id);
  }, [isGeneratingPage, loadCurrentPage, selectedCourse]);

  async function createCourseFromTopic(normalizedTopic: string) {
    if (!normalizedTopic || isCreating) {
      return;
    }

    setIsCreating(true);
    setError(null);
    setFeedback(null);

    try {
      const data = await readApiJson<ApiResult<{ course: Course }>>(
        await fetch("/api/courses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: normalizedTopic }),
        }),
      );

      if (!data.ok) {
        throw new Error(data.error);
      }

      setTopic("");
      syncCourse(data.course);
      setChatMessages((messages) => [
        ...messages,
        {
          id: chatMessageId(),
          role: "assistant",
          content: `Course ready: ${data.course.title}`,
        },
      ]);
      await loadCurrentPage(data.course.id);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create course.",
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function submitChatPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = topic.trim();

    if (!content || isChatBusy) {
      return;
    }

    const userMessage: LearnChatMessage = {
      id: chatMessageId(),
      role: "user",
      content,
    };
    const nextMessages = [...chatMessages, userMessage];

    setTopic("");
    setChatMessages(nextMessages);
    setIsIntaking(true);
    setError(null);
    setFeedback(null);

    try {
      const data = await readApiJson<
        ApiResult<{ decision: CourseIntakeDecision }>
      >(
        await fetch("/api/courses/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
        }),
      );

      if (!data.ok) {
        throw new Error(data.error);
      }

      setChatMessages((messages) => [
        ...messages,
        {
          id: chatMessageId(),
          role: "assistant",
          content: data.decision.message,
        },
      ]);

      if (data.decision.action === "create_course") {
        await createCourseFromTopic(data.decision.topic);
      }
    } catch (chatError) {
      setError(
        chatError instanceof Error
          ? chatError.message
          : "Could not continue Learn chat.",
      );
    } finally {
      setIsIntaking(false);
    }
  }

  async function submitChoice(choiceId: string) {
    if (!selectedCourse || !currentPage || isAnswering) {
      return;
    }

    setSelectedChoiceId(choiceId);
    setIsAnswering(true);
    setError(null);

    try {
      const data = await readApiJson<
        ApiResult<{ correct: boolean; feedback: string; course: Course }>
      >(
        await fetch(`/api/courses/${encodeURIComponent(selectedCourse.id)}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageId: currentPage.id,
            selectedChoiceId: choiceId,
          }),
        }),
      );

      if (!data.ok) {
        throw new Error(data.error);
      }

      setFeedback(data.feedback);
      syncCourse(data.course);

      if (data.correct && data.course.status !== "completed") {
        await loadCurrentPage(data.course.id);
      }
    } catch (answerError) {
      setError(
        answerError instanceof Error
          ? answerError.message
          : "Could not submit answer.",
      );
    } finally {
      setIsAnswering(false);
    }
  }

  function selectCourse(course: Course) {
    setSelectedCourse(course);
    setFeedback(null);
    setSelectedChoiceId(null);

    if (!course.pages) {
      void loadCourse(course.id).catch((loadError) => {
        setError(
          loadError instanceof Error ? loadError.message : "Could not load course.",
        );
      });
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
          <aside className="learn-sidebar" aria-label="Courses">
            <p className="learn-sidebar-label">Courses</p>

            <div className="learn-course-list" aria-label="Recent courses">
              {courses.map((course) => (
                <button
                  className={`learn-course-item ${
                    selectedCourse?.id === course.id
                      ? "learn-course-item-active"
                      : ""
                  }`}
                  type="button"
                  key={course.id}
                  onClick={() => selectCourse(course)}
                >
                  <span>{course.status === "completed" ? "Completed" : "Active"}</span>
                  <strong>{course.title}</strong>
                  <small>
                    {course.generatedPages}/{course.totalPages} pages
                  </small>
                </button>
              ))}

              {!isBooting && courses.length === 0 ? (
                <p className="learn-empty">No courses yet.</p>
              ) : null}
            </div>
          </aside>

          <section className="learn-reader">
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
              <section className="learn-chat-panel" aria-label="Learn chat">
                <div className="learn-chat-thread">
                  {chatMessages.map((message) => (
                    <div
                      className={`learn-chat-message learn-chat-message-${message.role}`}
                      key={message.id}
                    >
                      <p>{message.content}</p>
                    </div>
                  ))}
                  {isChatBusy ? (
                    <div
                      className="learn-chat-message learn-chat-message-assistant"
                      role="status"
                    >
                      <span className="pending-spinner" aria-hidden="true" />
                      <p>{isCreating ? "Generating course" : "Thinking"}</p>
                    </div>
                  ) : null}
                </div>
                <form className="learn-chat-composer" onSubmit={submitChatPrompt}>
                  <input
                    id="learn-topic-input"
                    type="text"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Learn convolutional neural networks for vision"
                    disabled={isChatBusy}
                  />
                  <button
                    type="submit"
                    disabled={!topic.trim() || isChatBusy}
                    aria-label="Send"
                    title="Send"
                  >
                    {isChatBusy ? (
                      <Loader2 className="learn-spin-icon" aria-hidden="true" />
                    ) : (
                      <SendHorizontal aria-hidden="true" />
                    )}
                  </button>
                </form>
              </section>
            ) : null}

            {!isBooting && selectedCourse ? (
              <>
                <div className="learn-course-heading">
                  <div>
                    <p className="learn-kicker">{selectedCourse.deckName}</p>
                    <h1>{selectedCourse.title}</h1>
                    {selectedCourse.description ? (
                      <p>{selectedCourse.description}</p>
                    ) : null}
                  </div>
                  <div className="learn-progress-pill" aria-label="Course progress">
                    <BookOpen aria-hidden="true" />
                    <span>
                      {selectedCourse.status === "completed"
                        ? selectedCourse.totalPages
                        : Math.max(
                            1,
                            pageOrdinal(
                              selectedCourse,
                              selectedCourse.currentChapterIndex,
                              selectedCourse.currentPageIndex,
                            ),
                          )}
                      /{selectedCourse.totalPages}
                    </span>
                  </div>
                </div>

                <div className="learn-layout">
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
                            const isGenerated = selectedCourse.pages?.some(
                              (coursePage) =>
                                coursePage.chapterIndex === chapterIndex &&
                                coursePage.pageIndex === pageIndex,
                            );

                            return (
                              <li
                                className={isCurrent ? "learn-toc-current" : ""}
                                key={`${chapterIndex}-${pageIndex}-${page.title}`}
                              >
                                <span>
                                  {isGenerated ? (
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

                  <article className="learn-page-card">
                    {selectedCourse.status === "completed" ? (
                      <div className="learn-complete">
                        <p className="learn-kicker">Complete</p>
                        <h2>{selectedCourse.title}</h2>
                        <p>Course cards are now in review rotation.</p>
                      </div>
                    ) : currentPage ? (
                      <>
                        <div className="learn-page-heading">
                          <p className="learn-kicker">
                            Chapter {currentPage.chapterIndex + 1} / Page{" "}
                            {currentPage.pageIndex + 1}
                          </p>
                          <h2>{currentPage.title}</h2>
                        </div>
                        <MarkdownContent
                          className="learn-page-body"
                          text={currentPage.body}
                          enableCodeBlocks
                          enableHeadings
                        />
                        {currentPageWidget ? (
                        <section
                          className="learn-quiz"
                          aria-label="Page question"
                          data-widget={currentPageWidget.type}
                        >
                          <p className="learn-quiz-question">
                            {currentPageWidget.question}
                          </p>
                          <div className="learn-choice-grid">
                            {currentPageWidget.choices.map((choice) => (
                              <button
                                className={`learn-choice ${
                                  selectedChoiceId === choice.id
                                    ? "learn-choice-selected"
                                    : ""
                                }`}
                                type="button"
                                key={choice.id}
                                disabled={isAnswering}
                                onClick={() => submitChoice(choice.id)}
                              >
                                <span>{choice.id}</span>
                                <p>{choice.text}</p>
                              </button>
                            ))}
                          </div>
                          {feedback ? (
                            <p className="learn-feedback" role="status">
                              {feedback}
                            </p>
                          ) : null}
                        </section>
                        ) : null}
                      </>
                    ) : (
                      <div className="learn-loading" role="status">
                        <span className="pending-spinner" aria-hidden="true" />
                        <span>
                          {isGeneratingPage ? "Generating page" : "Preparing page"}
                        </span>
                      </div>
                    )}
                  </article>
                </div>
              </>
            ) : null}
          </section>
        </section>
      </section>
    </main>
  );
}
