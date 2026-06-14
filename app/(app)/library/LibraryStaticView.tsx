import Image from "next/image";
import Link from "next/link";
import { isAdminEmail } from "@/app/lib/adminAccess";
import type { QuestionBankPage } from "@/app/lib/questionBank";

type LibraryStaticViewProps = {
  initialQuestionBank: QuestionBankPage;
  userEmail?: string | null;
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function toStaticAsciiText(text: string | null | undefined): string {
  return (text ?? "").replaceAll("\u2019", "'");
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "unscheduled";
  }

  return DATE_FORMATTER.format(new Date(value));
}

function questionStatus(item: QuestionBankPage["items"][number]): string {
  if (item.flaggedAt) {
    return "flagged";
  }

  if (item.nextDue <= Date.now()) {
    return "due";
  }

  return "scheduled";
}

export function LibraryStaticView({
  initialQuestionBank,
  userEmail,
}: LibraryStaticViewProps) {
  const showAdmin = isAdminEmail(userEmail);
  const items = initialQuestionBank.items;
  const questionCountLabel = initialQuestionBank.hasMore
    ? `${items.length}+ questions`
    : `${items.length} questions`;

  return (
    <main className="page page-library-active" data-library-static>
      <section className="review-shell tags-shell library-shell" aria-label="Question library">
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
              <Link className="reader-tab" href="/review" prefetch={false} role="tab" id="review-tab" aria-selected="false">
                Review
              </Link>
              <Link className="reader-tab" href="/learn" prefetch={false} role="tab" id="learn-tab" aria-selected="false">
                Learn
              </Link>
              <Link className="reader-tab reader-tab-active" href="/library" prefetch={false} role="tab" aria-selected="true">
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

        <section className="tags-stage library-stage" id="library-panel" role="tabpanel">
          <div className="tags-header library-header">
            <div>
              <p className="learn-kicker">Library</p>
              <h1>Question bank</h1>
            </div>
          </div>

          <div className="deck-search-shell library-token-search-shell">
            <input
              className="deck-search-input library-token-search-input"
              disabled
              placeholder="Search questions or type #tag"
              aria-label="Search question bank"
            />
          </div>

          <div className="tags-summary-strip library-summary-strip">
            <span>{questionCountLabel}</span>
            <span>{items.length} shown</span>
            <span>ready</span>
          </div>

          {items.length === 0 ? (
            <p className="tags-empty">No matching questions.</p>
          ) : (
            <ol className="library-question-list">
              {items.map((item) => {
                const statusLabel = questionStatus(item);

                return (
                  <li
                    className="previous-row previous-row-resolved previous-row-collapsed library-previous-row"
                    key={item.questionId}
                  >
                    <span className="previous-score-shell" aria-label="No score">
                      <span className="previous-score score-neutral">-</span>
                    </span>
                    <button className="previous-row-main-button" type="button" disabled>
                      <div className="previous-copy">
                        <div className="previous-field previous-question-field">
                          <span className="previous-label-row">
                            <span className="previous-field-label">
                              <span className="library-chip-row">
                                {item.conceptSlugs.length === 0 ? (
                                  <span className="library-chip library-chip-muted">
                                    untagged
                                  </span>
                                ) : (
                                  item.conceptSlugs.map((slug) => (
                                    <span className="library-chip" key={slug}>
                                      {slug}
                                    </span>
                                  ))
                                )}
                              </span>
                            </span>
                          </span>
                          <p className="previous-question">
                            {toStaticAsciiText(item.question)}
                          </p>
                        </div>
                      </div>
                      <span className="previous-row-meta">
                        <span className={`library-status library-status-${statusLabel}`}>
                          {statusLabel}
                        </span>
                        <span className="previous-time-control">
                          <span className="previous-time">
                            {formatDate(item.nextDue)}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </section>
    </main>
  );
}
