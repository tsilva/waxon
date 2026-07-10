"use client";

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
  CourseListCursor,
  CourseListItem,
  CoursesPageResponse,
  LearnPageClientProps,
  UserProfile,
} from "./learnTypes";
import {
  CourseSettingsModal,
  LearnCourseList,
  LearnCourseToolbar,
  LearnLoadingPlaceholders,
  REVIEW_COUNT_URL,
  courseListPageSizeForViewport,
  coursesPageUrl,
  learnCoursePath,
  readApiJson,
  sortCourses,
  updateLearnHistory,
} from "./LearnCourseListShared";

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
                <LearnCourseList
                  activeCourseSearchQuery={activeCourseSearchQuery}
                  courses={courses}
                  createDisabled={createDisabled}
                  hasMoreCourses={hasMoreCourses}
                  isLoadingCoursesPage={isLoadingCoursesPage}
                  loadingCourseId={loadingCourseId}
                  courseListMoreRef={courseListMoreRef}
                  onLoadMore={() => {
                    void loadNextCoursesPage();
                  }}
                  onOpenCourse={(courseId) => {
                    void openCourse(courseId);
                  }}
                  onOpenCourseSettings={openCourseSettings}
                />
              </section>
            </div>
          )}
        </section>
      </section>

      {courseSettingsCourse ? (
        <CourseSettingsModal
          course={courseSettingsCourse}
          isDeletingCourse={isDeletingCourse}
          message={courseSettingsMessage}
          onClose={closeCourseSettings}
          onDelete={() => {
            void deleteSelectedCourse();
          }}
        />
      ) : null}
    </main>
  );
}
