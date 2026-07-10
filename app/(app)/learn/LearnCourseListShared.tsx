"use client";

import { BookOpen, Loader2, PlusCircle, Search, Settings, Trash2 } from "lucide-react";
import type { MutableRefObject } from "react";
import type {
  CourseListCursor,
  CourseListItem,
} from "./learnTypes";

const COURSE_LIST_FALLBACK_PAGE_SIZE = 8;
const COURSE_LIST_MIN_PAGE_SIZE = 4;
const COURSE_LIST_MAX_PAGE_SIZE = 24;
const COURSE_LIST_MOBILE_BREAKPOINT = 760;
const COURSE_LIST_DESKTOP_VERTICAL_CHROME_PX = 195;
const COURSE_LIST_MOBILE_VERTICAL_CHROME_PX = 208;
const COURSE_LIST_DESKTOP_ROW_PITCH_PX = 80;
const COURSE_LIST_MOBILE_ROW_PITCH_PX = 150;

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

export const REVIEW_COUNT_URL =
  "/api/review-summary";

export function coursesPageUrl(input: {
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

export function courseListPageSizeForViewport(): number {
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
    Math.min(
      COURSE_LIST_MAX_PAGE_SIZE,
      Math.ceil(availableListHeight / rowPitch),
    ),
  );
}

export async function readApiJson<T>(response: Response): Promise<T> {
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

export function formatCourseUpdatedAt(timestamp: number): string {
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

export function learnCoursePath(courseId: string): string {
  return `/learn/courses/${encodeURIComponent(courseId)}`;
}

export function updateLearnHistory(
  pathname: string,
  mode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined" || window.location.pathname === pathname) {
    return;
  }

  if (mode === "replace") {
    window.history.replaceState(null, "", pathname);
    return;
  }

  window.history.pushState(null, "", pathname);
}

export function sortCourses(courses: CourseListItem[]): CourseListItem[] {
  return [...courses].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.title.localeCompare(right.title),
  );
}

type CourseToolbarProps = {
  courseSearchQuery: string;
  createDisabled: boolean;
  onCourseSearchQueryChange: (value: string) => void;
  onCreateCourse: () => void;
};

export function LearnCourseToolbar({
  courseSearchQuery,
  createDisabled,
  onCourseSearchQueryChange,
  onCreateCourse,
}: CourseToolbarProps) {
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

export function LearnLoadingPlaceholders(props: CourseToolbarProps) {
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
        <LearnCourseToolbar {...props} />
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

export function LearnCourseList({
  activeCourseSearchQuery,
  courses,
  createDisabled,
  hasMoreCourses,
  isLoadingCoursesPage,
  loadingCourseId,
  courseListMoreRef,
  onLoadMore,
  onOpenCourse,
  onOpenCourseSettings,
}: {
  activeCourseSearchQuery: string;
  courses: CourseListItem[];
  createDisabled: boolean;
  hasMoreCourses: boolean;
  isLoadingCoursesPage: boolean;
  loadingCourseId: string | null;
  courseListMoreRef: MutableRefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  onOpenCourse: (courseId: string) => void;
  onOpenCourseSettings: (course: CourseListItem) => void;
}) {
  return (
    <div className="learn-course-list">
      {courses.length === 0 && !isLoadingCoursesPage ? (
        <p className="learn-course-empty">
          {activeCourseSearchQuery ? "No matching courses." : "No courses yet."}
        </p>
      ) : null}
      {courses.map((course) => (
        <article className="learn-course-item learn-course-card" key={course.id}>
          <button
            className="learn-course-open"
            disabled={createDisabled}
            type="button"
            onClick={() => onOpenCourse(course.id)}
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
                    : `${course.chatMessageCount} messages`}
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
            onClick={() => onOpenCourseSettings(course)}
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
        <div className="learn-course-load-sentinel" ref={courseListMoreRef}>
          <button
            className="learn-course-load-more"
            disabled={isLoadingCoursesPage}
            type="button"
            onClick={onLoadMore}
          >
            {isLoadingCoursesPage ? "Loading" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CourseSettingsModal({
  course,
  isDeletingCourse,
  message,
  onClose,
  onDelete,
}: {
  course: CourseListItem;
  isDeletingCourse: boolean;
  message: string | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
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
              {course.title}
            </h2>
          </div>
          <button
            className="stats-modal-close"
            type="button"
            aria-label="Close course settings"
            disabled={isDeletingCourse}
            onClick={onClose}
          />
        </div>

        <dl className="course-settings-summary" aria-label="Course summary">
          <div>
            <dt>{course.totalPages}</dt>
            <dd>course sections</dd>
          </div>
          <div>
            <dt>{course.chatMessageCount}</dt>
            <dd>chat messages</dd>
          </div>
          <div>
            <dt>{formatCourseUpdatedAt(course.updatedAt)}</dt>
            <dd>last updated</dd>
          </div>
        </dl>

        <div className="course-settings-danger">
          <div>
            <h3>Delete course</h3>
            <p>
              This removes the course, its chat, and generated review questions.
            </p>
          </div>
          <button
            className="course-delete-action"
            type="button"
            disabled={isDeletingCourse}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
            <span>{isDeletingCourse ? "Deleting..." : "Delete course and data"}</span>
          </button>
        </div>

        {message ? (
          <p className="kb-editor-status" role="alert">
            {message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
