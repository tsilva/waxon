import Image from "next/image";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { isAdminEmail } from "@/app/lib/adminAccess";
import type { QuestionAttempt, ReviewQueueItem } from "@/app/lib/reviewTypes";

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type QueueStatusResponse = {
  queueRemaining: number;
  recentAttempts?: QuestionAttempt[];
};

export type ReviewInitialViewProps = {
  initialCurrentUser?: UserProfileResponse | null;
  initialPreviousAnswerStatus?: QueueStatusResponse | null;
  initialReviewSessionQueue?: ReviewQueueItem[] | null;
};

function formatRelativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return "Just now";
  }

  const elapsedSeconds = Math.floor(Math.max(0, Date.now() - timestamp) / 1000);

  if (elapsedSeconds < 60) {
    return "Just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function StaticPreviousScore({ score }: { score: number | null }) {
  const tone =
    score === null ? "neutral" : score >= 7 ? "high" : score === 6 ? "medium" : "low";

  return (
    <span
      className="previous-score-shell"
      aria-label={score === null ? "No score" : `Score ${score} out of 10`}
    >
      <span className={`previous-score score-${tone}`}>
        {score === null ? "-" : score}
      </span>
    </span>
  );
}

function toStaticAsciiText(text: string | null | undefined): string {
  return (text ?? "").replaceAll("\u2019", "'");
}

function renderStaticInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const segments = text.split("`");

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (!segment) {
      continue;
    }

    if (index % 2 === 1) {
      nodes.push(
        <code className="markdown-inline-code" key={`code-${index}`}>
          {segment}
        </code>,
      );
    } else {
      nodes.push(<Fragment key={`text-${index}`}>{segment}</Fragment>);
    }
  }

  return nodes;
}

export function ReviewStaticView({
  initialCurrentUser,
  initialPreviousAnswerStatus,
  initialReviewSessionQueue,
}: ReviewInitialViewProps) {
  const currentQuestion = initialReviewSessionQueue?.[0] ?? null;
  const previousAnswers = (initialPreviousAnswerStatus?.recentAttempts ?? [])
    .filter((attempt) => attempt.question !== currentQuestion?.question)
    .slice(0, 6);
  const visiblePreviousAnswers = previousAnswers.slice(0, 2);
  const showAdmin = isAdminEmail(initialCurrentUser?.email);

  return (
    <main className="page" data-review-static>
      <section className="review-shell" aria-label="Flashcard learning">
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
              <Link
                className="reader-tab reader-tab-active"
                href="/review"
                prefetch={false}
                role="tab"
                id="review-tab"
                aria-selected="true"
                aria-controls="review-panel"
              >
                Review
              </Link>
              <Link
                className="reader-tab"
                href="/learn"
                prefetch={false}
                role="tab"
                id="learn-tab"
                aria-selected="false"
                aria-controls="learn-panel"
              >
                Learn
              </Link>
              <Link className="reader-tab" href="/library" prefetch={false} role="tab" aria-selected="false">
                Library
              </Link>
              <Link className="reader-tab" href="/tags" prefetch={false} role="tab" aria-selected="false">
                Tags
              </Link>
              {showAdmin ? (
                <Link className="reader-tab" href="/admin" prefetch={false} role="tab" aria-selected="false">
                  Admin
                </Link>
              ) : null}
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        <div className="review-stage" id="review-panel" role="tabpanel" aria-labelledby="review-tab">
          <section className="question-area" aria-live="polite">
            <div className="question-copy">
              <div className="question-swap-stack">
                <div className="question-swap-layer">
                  {currentQuestion?.deckName ? (
                    <div className="question-source">
                      <span className="question-source-label">
                        {currentQuestion.deckName}
                      </span>
                    </div>
                  ) : null}
                  <h2 className="question-title">
                    {renderStaticInlineMarkdown(
                      toStaticAsciiText(currentQuestion?.question) ||
                        "Loading next question...",
                    )}
                  </h2>
                </div>
              </div>
            </div>
          </section>

          <div className="composer">
            <div className="composer-row">
              <textarea
                className="composer-input"
                value=""
                disabled
                placeholder="Type your answer here..."
                aria-label="Your answer"
                rows={4}
              />
              <button className="composer-mic" type="button" aria-label="Start voice answer" disabled />
              <button className="composer-submit" type="button" aria-label="Submit answer" disabled />
            </div>
          </div>

          <section className="previous-panel" aria-label="Previous answers">
            <div className="previous-header">
              <h2>Previous answers</h2>
            </div>

            <ol className="previous-list">
              {visiblePreviousAnswers.map((attempt) => (
                <li className="previous-row previous-row-resolved previous-row-collapsed" key={attempt.id}>
                  <StaticPreviousScore score={attempt.score} />
                  <div className="previous-copy">
                    <div className="previous-field previous-question-field">
                      <span className="previous-label-row">
                        <span className="previous-field-label">Question</span>
                      </span>
                      <p className="previous-question">
                        {toStaticAsciiText(attempt.question)}
                      </p>
                      <p className="previous-question-feedback">
                        {toStaticAsciiText(attempt.justification) ||
                          "No feedback returned."}
                      </p>
                    </div>
                  </div>
                  <span className="previous-row-meta">
                    <span className="previous-time-control">
                      <time
                        className="previous-time"
                        dateTime={new Date(attempt.resolvedAt || attempt.submittedAt).toISOString()}
                      >
                        {formatRelativeTime(attempt.resolvedAt || attempt.submittedAt)}
                      </time>
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {previousAnswers.length > visiblePreviousAnswers.length ? (
              <button className="load-more-answers" type="button" disabled>
                Load more
              </button>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
