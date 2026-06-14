import Image from "next/image";
import Link from "next/link";

export function TagsStaticView() {
  return (
    <main className="page page-review page-tags" data-tags-static>
      <section className="review-shell tags-shell" aria-label="Concept tags">
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
              <Link className="reader-tab" href="/review" prefetch={false} role="tab" aria-selected="false">
                Review
              </Link>
              <Link className="reader-tab" href="/learn" prefetch={false} role="tab" aria-selected="false">
                Learn
              </Link>
              <Link className="reader-tab" href="/library" prefetch={false} role="tab" aria-selected="false">
                Library
              </Link>
              <Link className="reader-tab reader-tab-active" href="/tags" prefetch={false} role="tab" aria-selected="true">
                Tags
              </Link>
            </div>
          </div>
          <div className="reader-actions reader-actions-placeholder" />
        </header>

        <section className="queue-stage tags-stage" aria-labelledby="tags-title">
          <div className="queue-toolbar">
            <div>
              <p className="stats-page-kicker">Concept tags</p>
              <h1 id="tags-title" className="tags-title">
                Review controls
              </h1>
            </div>
            <label className="deck-search-label tags-search-label">
              <span className="sr-only">Search concept tags</span>
              <span className="deck-search-shell">
                <input
                  className="deck-search-input"
                  disabled
                  placeholder="Search tags"
                />
              </span>
            </label>
          </div>

          <div className="tags-summary-strip">
            <span>0 tags</span>
            <span>0 active</span>
            <span>0 muted</span>
            <span>loading</span>
          </div>

          <section className="tags-section" aria-label="Active tags">
            <h2>Active</h2>
            <p className="tags-empty">Loading concept tags.</p>
          </section>
        </section>
      </section>
    </main>
  );
}
