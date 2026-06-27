import Image from "next/image";
import Link from "next/link";

type AppStaticLoadingViewProps = {
  staticView?: "review" | "learn" | "library" | "tags" | "admin";
};

const staticViewAttributes = {
  review: { "data-review-static": true },
  learn: { "data-learn-static": true },
  library: { "data-library-static": true },
  tags: { "data-tags-static": true },
  admin: { "data-admin-static": true },
} as const;

const readerTabs = [
  ["Review", "/review"],
  ["Learn", "/learn"],
  ["Library", "/library"],
  ["Tags", "/tags"],
] as const;

export function AppStaticLoadingView({
  staticView,
}: AppStaticLoadingViewProps) {
  const markerAttributes = staticView
    ? staticViewAttributes[staticView]
    : undefined;

  return (
    <main className="page page-route-loading" {...markerAttributes}>
      <section className="review-shell" aria-label="Loading Waxon view">
        <header className="reader-header reader-header-route-loading">
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
            <div
              className="reader-tabs reader-tabs-route-loading"
              role="tablist"
              aria-label="Waxon views"
              aria-busy="true"
            >
              {readerTabs.map(([label, href]) => (
                <Link
                  className="reader-tab"
                  href={href}
                  key={href}
                  prefetch={false}
                  role="tab"
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        {staticView === "review" ? (
          <ReviewRouteLoadingStage />
        ) : (
          <div className="route-loading-stage" aria-hidden="true" />
        )}
      </section>
    </main>
  );
}

function ReviewRouteLoadingStage() {
  return (
    <div
      className="review-stage route-loading-review-stage"
      aria-hidden="true"
    >
      <section className="question-area">
        <div className="question-copy">
          <h2 className="question-title">Loading next question...</h2>
        </div>
      </section>

      <div className="composer composer-loading">
        <div className="composer-row composer-loading-row">
          <div className="composer-loading-input" />
          <div className="composer-loading-button" />
          <div className="composer-loading-button composer-loading-button-accent" />
        </div>
      </div>

      <section className="previous-panel">
        <div className="previous-header">
          <h2>Previous answers</h2>
        </div>

        <ol className="previous-list">
          {Array.from({ length: 2 }).map((_, index) => (
            <li
              className="previous-row previous-row-placeholder"
              key={`route-loading-previous-placeholder-${index}`}
            >
              <div className="previous-placeholder-score" />
              <div className="previous-placeholder-copy">
                <span />
                <span />
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
