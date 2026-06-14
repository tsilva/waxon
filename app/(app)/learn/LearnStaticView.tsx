import Image from "next/image";
import Link from "next/link";
import type { Course } from "./LearnPageClient";

type LearnStaticViewProps = {
  initialCourses?: Course[] | null;
};

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

function toStaticAsciiText(text: string | null | undefined): string {
  return (text ?? "").replaceAll("\u2019", "'");
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

function courseProgressLabel(course: Course): string {
  if (course.status === "completed") {
    return "Completed";
  }

  return `Page ${Math.min(course.generatedPages + 1, course.totalPages)} of ${course.totalPages}`;
}

export function LearnStaticView({ initialCourses }: LearnStaticViewProps) {
  const courses = initialCourses ?? [];

  return (
    <main className="page page-learn-active" data-learn-static>
      <section className="review-shell learn-shell" aria-label="Course learning">
        <header className="reader-header">
          <div className="reader-heading">
            <Link className="reader-brand admin-brand-link" href="/" prefetch={false}>
              <Image
                className="reader-brand-mark"
                src="/brand/icon/header-mark.svg"
                alt=""
                aria-hidden="true"
                width={34}
                height={34}
              />
              <span>waxon</span>
            </Link>
            <div className="reader-tabs" role="tablist" aria-label="Waxon views">
              <Link className="reader-tab" href="/review" prefetch={false} role="tab" id="review-tab" aria-selected="false" aria-controls="review-panel">
                Review
              </Link>
              <Link className="reader-tab reader-tab-active" href="/learn" prefetch={false} role="tab" id="learn-tab" aria-selected="true" aria-controls="learn-panel">
                Learn
              </Link>
              <Link className="reader-tab" href="/library" prefetch={false} role="tab" aria-selected="false">
                Library
              </Link>
              <Link className="reader-tab" href="/tags" prefetch={false} role="tab" aria-selected="false">
                Tags
              </Link>
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        <section className="learn-stage" id="learn-panel" role="tabpanel" aria-labelledby="learn-tab">
          <div className="learn-chat-layout learn-chat-layout-course-list">
            <section className="learn-course-picker learn-course-picker-full" aria-label="Courses">
              <div className="learn-course-picker-heading">
                <p className="learn-kicker">Courses</p>
              </div>
              <div className="learn-course-list">
                <button className="learn-course-item learn-course-new" aria-label="New course" disabled type="button">
                  <span className="learn-course-new-kicker">Create</span>
                  <strong>New course</strong>
                  <small>Ready for a learning goal</small>
                  <span className="learn-course-new-rail" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </button>
                {courses.map((course) => (
                  <article className="learn-course-item learn-course-card" key={course.id}>
                    <Link className="learn-course-open" href={`/learn/courses/${encodeURIComponent(course.id)}`} prefetch={false}>
                      <span>{courseProgressLabel(course)}</span>
                      <strong>{toStaticAsciiText(course.title)}</strong>
                      <small className="learn-course-meta">
                        {course.generatedPages}/{course.totalPages} generated{" / "}
                        <time
                          className="learn-course-updated"
                          dateTime={new Date(course.updatedAt).toISOString()}
                          title={formatCourseUpdatedTitle(course.updatedAt)}
                        >
                          Updated {formatCourseUpdatedAt(course.updatedAt)}
                        </time>
                      </small>
                    </Link>
                    <button
                      className="learn-course-settings-trigger"
                      disabled
                      type="button"
                      aria-label={`Open ${toStaticAsciiText(course.title)} settings`}
                    />
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>
      </section>
    </main>
  );
}
