"use client";

import {
  BookOpen,
  Loader2,
  PlusCircle,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";
import { useToolbarAccount } from "@/app/lib/useToolbarAccount";
import type {
  Course,
  CourseListItem,
  LearnPageClientProps,
  UserProfile,
} from "./LearnPageClient";

type CourseListCursor = {
  updatedAt: number;
  id: string;
};

type CoursesPageResponse = {
  courses?: CourseListItem[];
  hasMore?: boolean;
  nextCursor?: CourseListCursor | null;
};

const COURSE_LIST_FALLBACK_PAGE_SIZE = 8;
const COURSE_LIST_MIN_PAGE_SIZE = 4;
const COURSE_LIST_MAX_PAGE_SIZE = 24;
const COURSE_LIST_MOBILE_BREAKPOINT = 760;
const COURSE_LIST_DESKTOP_VERTICAL_CHROME_PX = 195;
const COURSE_LIST_MOBILE_VERTICAL_CHROME_PX = 208;
const COURSE_LIST_DESKTOP_ROW_PITCH_PX = 80;
const COURSE_LIST_MOBILE_ROW_PITCH_PX = 150;
const REVIEW_COUNT_URL =
  "/api/queue-status?mode=review&includeReviewQueue=0&includeRecentAttempts=0&includeQuestionAttempts=0&includeEvaluations=0&includeKnowledgeEmbeddingPlot=0&includeQueueCounts=1";

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

function coursesPageUrl(input: {
  cursor?: CourseListCursor | null;
  limit: number;
  search?: string;
}): string {
  const searchParams = new URLSearchParams();

  searchParams.set("limit", String(input.limit));

  if (input.search?.trim()) {
    searchParams.set("search", input.search.trim());
  }

  if (input.cursor) {
    searchParams.set("cursorUpdatedAt", String(input.cursor.updatedAt));
    searchParams.set("cursorId", input.cursor.id);
  }

  return `/api/courses?${searchParams.toString()}`;
}

function courseListPageSizeForViewport(): number {
  if (typeof window === "undefined") {
    return COURSE_LIST_FALLBACK_PAGE_SIZE;
  }

  const isMobile = window.innerWidth <= COURSE_LIST_MOBILE_BREAKPOINT;
  const availableListHeight = Math.max(
    isMobile
      ? window.innerHeight - COURSE_LIST_MOBILE_VERTICAL_CHROME_PX
      : window.innerHeight - COURSE_LIST_DESKTOP_VERTICAL_CHROME_PX,
    0,
  );
  const rowPitch = isMobile
    ? COURSE_LIST_MOBILE_ROW_PITCH_PX
    : COURSE_LIST_DESKTOP_ROW_PITCH_PX;

  return Math.max(
    COURSE_LIST_MIN_PAGE_SIZE,
    Math.min(COURSE_LIST_MAX_PAGE_SIZE, Math.ceil(availableListHeight / rowPitch)),
  );
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

function courseProgressLabel(course: CourseListItem): string {
  if (course.status === "completed") {
    return "Completed";
  }

  const totalPages = Math.max(course.totalPages, 1);
  const currentPage = Math.min(course.currentPageIndex + 1, totalPages);

  return `${currentPage} of ${totalPages}`;
}

function learnCoursePath(courseId: string): string {
  return `/learn/courses/${encodeURIComponent(courseId)}`;
}

function updateLearnHistory(pathname: string) {
  if (typeof window === "undefined" || window.location.pathname === pathname) {
    return;
  }

  window.history.pushState(null, "", pathname);
}

function LearnCourseToolbar({
  courseSearchQuery,
  createDisabled,
  onCourseSearchQueryChange,
  onCreateCourse,
}: {
  courseSearchQuery: string;
  createDisabled: boolean;
  onCourseSearchQueryChange: (value: string) => void;
  onCreateCourse: () => void;
}) {
  return (
    <div className="learn-course-toolbar">
      <label className="learn-course-search-shell">
        <Search aria-hidden="true" />
        <span className="sr-only">Search courses</span>
        <input
          className="learn-course-search-input"
          type="search"
          value={courseSearchQuery}
          onChange={(event) => onCourseSearchQueryChange(event.target.value)}
          placeholder="Search courses"
        />
      </label>
      <button
        className="learn-course-create-button"
        disabled={createDisabled}
        type="button"
        onClick={onCreateCourse}
      >
        <PlusCircle aria-hidden="true" />
        Create
      </button>
    </div>
  );
}

function LearnLoadingPlaceholders({
  courseSearchQuery,
  createDisabled,
  onCourseSearchQueryChange,
  onCreateCourse,
}: {
  courseSearchQuery: string;
  createDisabled: boolean;
  onCourseSearchQueryChange: (value: string) => void;
  onCreateCourse: () => void;
}) {
  return (
    <div className="learn-chat-layout learn-chat-layout-course-list learn-loading-layout">
      <section
        className="learn-course-picker learn-course-picker-full learn-loading-courses"
        aria-label="Courses"
        aria-busy="true"
      >
        <p className="sr-only" role="status">
          Loading courses
        </p>
        <LearnCourseToolbar
          courseSearchQuery={courseSearchQuery}
          createDisabled={createDisabled}
          onCourseSearchQueryChange={onCourseSearchQueryChange}
          onCreateCourse={onCreateCourse}
        />
        <div className="learn-course-list" aria-hidden="true">
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

function sortCourses(courses: CourseListItem[]): CourseListItem[] {
  return [...courses].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.title.localeCompare(right.title),
  );
}

export default function LearnCoursesPageClient() {
  const [LearnClient, setLearnClient] =
    useState<ComponentType<LearnPageClientProps> | null>(null);
  const [learnClientProps, setLearnClientProps] =
    useState<LearnPageClientProps | null>(null);
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [courseListCursor, setCourseListCursor] =
    useState<CourseListCursor | null>(null);
  const [hasMoreCourses, setHasMoreCourses] = useState(false);
  const [isLoadingCoursesPage, setIsLoadingCoursesPage] = useState(true);
  const [courseSearchQuery, setCourseSearchQuery] = useState("");
  const [activeCourseSearchQuery, setActiveCourseSearchQuery] = useState("");
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [loadingCourseId, setLoadingCourseId] = useState<string | null>(null);
  const [isStartingNewCourse, setIsStartingNewCourse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courseSettingsId, setCourseSettingsId] = useState<string | null>(null);
  const [isDeletingCourse, setIsDeletingCourse] = useState(false);
  const [courseSettingsMessage, setCourseSettingsMessage] =
    useState<string | null>(null);
  const coursePickerRef = useRef<HTMLElement | null>(null);
  const courseListMoreRef = useRef<HTMLDivElement | null>(null);
  const courseListPageSizeRef = useRef(courseListPageSizeForViewport());
  const courseSettingsCourse = useMemo(
    () => courses.find((course) => course.id === courseSettingsId) ?? null,
    [courseSettingsId, courses],
  );
  const {
    canViewAdmin,
    menuAvatarUrl,
    menuDisplayName,
    menuEmail,
    onManageAccount,
    onSignOut,
  } = useToolbarAccount(currentUser, {
    fallbackDisplayName: "Waxon user",
    localManageHref: "/review",
    localSignOutHref: "/",
  });

  usePageScrollLock(Boolean(courseSettingsCourse));

  const applyCoursesPage = useCallback(
    (page: CoursesPageResponse, mode: "replace" | "append") => {
      const pageCourses = page.courses ?? [];

      setCourses((items) => {
        if (mode === "replace") {
          return pageCourses;
        }

        const incomingIds = new Set(pageCourses.map((course) => course.id));

        return sortCourses([
          ...items.filter((course) => !incomingIds.has(course.id)),
          ...pageCourses,
        ]);
      });
      setHasMoreCourses(Boolean(page.hasMore));
      setCourseListCursor(page.nextCursor ?? null);
    },
    [],
  );

  useEffect(() => {
    let isCancelled = false;

    async function loadCourses() {
      setIsLoadingCoursesPage(true);

      try {
        const response = await fetch(
          coursesPageUrl({ limit: courseListPageSizeRef.current }),
          { cache: "no-store" },
        );
        const page = await readApiJson<CoursesPageResponse>(response);

        if (!isCancelled) {
          applyCoursesPage(page, "replace");
          setActiveCourseSearchQuery("");
        }
      } catch (loadError) {
        if (!isCancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Could not load courses.",
          );
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingCoursesPage(false);
        }
      }
    }

    async function loadToolbarMetadata() {
      try {
        const [userResponse, queueResponse] = await Promise.all([
          fetch("/api/user", { cache: "no-store" }),
          fetch(REVIEW_COUNT_URL, { cache: "no-store" }),
        ]);
        const userData = await readApiJson<UserProfile>(userResponse);
        const queueData = await readApiJson<{ queueRemaining?: number }>(
          queueResponse,
        );

        if (!isCancelled) {
          setCurrentUser(userData);
          setDueCount(queueData.queueRemaining ?? 0);
        }
      } catch {
        if (!isCancelled) {
          setDueCount(null);
        }
      }
    }

    void loadCourses();
    void loadToolbarMetadata();

    return () => {
      isCancelled = true;
    };
  }, [applyCoursesPage]);

  useEffect(() => {
    if (LearnClient || isLoadingCoursesPage) {
      return;
    }

    const normalizedSearch = courseSearchQuery.trim();

    if (normalizedSearch === activeCourseSearchQuery) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setIsLoadingCoursesPage(true);
      setError(null);

      try {
        const response = await fetch(
          coursesPageUrl({
            limit: courseListPageSizeRef.current,
            search: normalizedSearch,
          }),
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const page = await readApiJson<CoursesPageResponse>(response);

        if (!controller.signal.aborted) {
          applyCoursesPage(page, "replace");
          setActiveCourseSearchQuery(normalizedSearch);
        }
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setError(
            searchError instanceof Error
              ? searchError.message
              : "Could not search courses.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingCoursesPage(false);
        }
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    LearnClient,
    activeCourseSearchQuery,
    applyCoursesPage,
    courseSearchQuery,
    isLoadingCoursesPage,
  ]);

  const loadNextCoursesPage = useCallback(async () => {
    if (isLoadingCoursesPage || !hasMoreCourses || !courseListCursor) {
      return;
    }

    setIsLoadingCoursesPage(true);
    setError(null);

    try {
      const response = await fetch(
        coursesPageUrl({
          cursor: courseListCursor,
          limit: courseListPageSizeRef.current,
          search: activeCourseSearchQuery,
        }),
        { cache: "no-store" },
      );
      const page = await readApiJson<CoursesPageResponse>(response);

      applyCoursesPage(page, "append");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load more courses.",
      );
    } finally {
      setIsLoadingCoursesPage(false);
    }
  }, [
    activeCourseSearchQuery,
    applyCoursesPage,
    courseListCursor,
    hasMoreCourses,
    isLoadingCoursesPage,
  ]);

  useEffect(() => {
    const coursePicker = coursePickerRef.current;
    const loadMoreTarget = courseListMoreRef.current;

    if (
      LearnClient ||
      !coursePicker ||
      !loadMoreTarget ||
      !hasMoreCourses ||
      isLoadingCoursesPage
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNextCoursesPage();
        }
      },
      {
        root: coursePicker,
        rootMargin: "0px",
        threshold: 0,
      },
    );

    observer.observe(loadMoreTarget);

    return () => observer.disconnect();
  }, [LearnClient, hasMoreCourses, isLoadingCoursesPage, loadNextCoursesPage]);

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

  async function openCourse(courseId: string) {
    if (loadingCourseId || isStartingNewCourse) {
      return;
    }

    setError(null);
    setLoadingCourseId(courseId);

    try {
      const [learnModule, response] = await Promise.all([
        import("./LearnPageClient"),
        fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
          cache: "no-store",
        }),
      ]);
      const data = await readApiJson<{ course: Course }>(response);
      const nextCourses = sortCourses([
        data.course,
        ...courses.filter((course) => course.id !== data.course.id),
      ]);

      setLearnClient(() => learnModule.default);
      setLearnClientProps({
        initialCourses: nextCourses,
        initialCurrentUser: currentUser,
        initialDueCount: dueCount ?? undefined,
        initialSelectedCourse: data.course,
      });
      updateLearnHistory(learnCoursePath(data.course.id));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load course.",
      );
      setLoadingCourseId(null);
    }
  }

  async function startNewCourse() {
    if (loadingCourseId || isStartingNewCourse) {
      return;
    }

    setError(null);
    setIsStartingNewCourse(true);

    try {
      const learnModule = await import("./LearnPageClient");

      setLearnClient(() => learnModule.default);
      setLearnClientProps({
        initialCourses: courses,
        initialCurrentUser: currentUser,
        initialDueCount: dueCount ?? undefined,
        initialIsStartingNewCourse: true,
      });
      updateLearnHistory("/learn");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not start a new course.",
      );
      setIsStartingNewCourse(false);
    }
  }

  function openCourseSettings(course: CourseListItem) {
    if (loadingCourseId || isStartingNewCourse) {
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

  if (LearnClient && learnClientProps) {
    return <LearnClient {...learnClientProps} />;
  }

  const createDisabled = Boolean(loadingCourseId || isStartingNewCourse);
  const shouldShowInitialLoading = isLoadingCoursesPage && courses.length === 0;

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
          onManageAccount={onManageAccount}
          onSignOut={onSignOut}
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

          {shouldShowInitialLoading ? (
            <LearnLoadingPlaceholders
              courseSearchQuery={courseSearchQuery}
              createDisabled={createDisabled}
              onCourseSearchQueryChange={setCourseSearchQuery}
              onCreateCourse={() => {
                void startNewCourse();
              }}
            />
          ) : (
            <div className="learn-chat-layout learn-chat-layout-course-list">
              <section
                className="learn-course-picker learn-course-picker-full"
                aria-label="Courses"
                aria-busy={isLoadingCoursesPage}
                ref={coursePickerRef}
              >
                <LearnCourseToolbar
                  courseSearchQuery={courseSearchQuery}
                  createDisabled={createDisabled}
                  onCourseSearchQueryChange={setCourseSearchQuery}
                  onCreateCourse={() => {
                    void startNewCourse();
                  }}
                />
                <div className="learn-course-list">
                  {courses.length === 0 && !isLoadingCoursesPage ? (
                    <p className="learn-course-empty">
                      {activeCourseSearchQuery ? "No matching courses." : "No courses yet."}
                    </p>
                  ) : null}
                  {courses.map((course) => (
                    <article
                      className="learn-course-item learn-course-card"
                      key={course.id}
                    >
                      <button
                        className="learn-course-open"
                        disabled={createDisabled}
                        type="button"
                        onClick={() => {
                          void openCourse(course.id);
                        }}
                      >
                        <strong>{course.title}</strong>
                        <span className="learn-course-state-panel">
                          <span className="learn-course-progress">
                            <BookOpen aria-hidden="true" />
                            {courseProgressLabel(course)}
                          </span>
                          <small className="learn-course-meta">
                            <span>
                              {loadingCourseId === course.id
                                ? "Loading"
                                : `${course.generatedPages}/${course.totalPages} generated`}
                            </span>
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
                        disabled={createDisabled}
                        type="button"
                        aria-label={`Open ${course.title} settings`}
                        onClick={() => openCourseSettings(course)}
                      >
                        <Settings aria-hidden="true" />
                      </button>
                    </article>
                  ))}
                  {isLoadingCoursesPage && courses.length > 0 ? (
                    <p className="learn-course-loading-more" role="status">
                      <Loader2 className="learn-spin-icon" aria-hidden="true" />
                      Loading more courses
                    </p>
                  ) : null}
                  {hasMoreCourses ? (
                    <div
                      className="learn-course-load-sentinel"
                      ref={courseListMoreRef}
                    >
                      <button
                        className="learn-course-load-more"
                        disabled={isLoadingCoursesPage}
                        type="button"
                        onClick={() => {
                          void loadNextCoursesPage();
                        }}
                      >
                        {isLoadingCoursesPage ? "Loading" : "Load more"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          )}
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
                  This removes the course, its chat, generated pages, page attempts,
                  and generated review questions.
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
    </main>
  );
}
