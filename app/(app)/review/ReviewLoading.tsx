// The server shell and the hydrated loading state share the same geometry.
export function ReviewQuestionSkeleton() {
  return (
    <div className="question-copy review-question-skeleton" aria-hidden="true">
      <div className="review-question-tags review-skeleton-tags">
        <span className="review-skeleton review-skeleton-tag" />
        <span className="review-skeleton review-skeleton-tag" />
      </div>
      <div className="review-question-heading">
        <div className="review-skeleton-prompt">
          <span className="review-skeleton" />
          <span className="review-skeleton" />
        </div>
        <div className="review-question-actions">
          <span className="review-skeleton review-skeleton-action" />
          <span className="review-skeleton review-skeleton-action" />
        </div>
      </div>
    </div>
  );
}

export function ReviewComposerSkeleton() {
  return (
    <div className="composer composer-loading" aria-hidden="true">
      <div className="composer-row composer-loading-row">
        <div className="composer-loading-input">
          <span className="review-skeleton" />
        </div>
        <span className="review-skeleton composer-loading-button composer-loading-button-accent" />
      </div>
    </div>
  );
}

export function ReviewHistorySkeleton() {
  return Array.from({ length: 2 }, (_, index) => (
    <li className="previous-row previous-row-placeholder" key={index} aria-hidden="true">
      <div className="review-skeleton previous-placeholder-score" />
      <div className="previous-placeholder-copy">
        <span className="review-skeleton" />
        <span className="review-skeleton" />
        <span className="review-skeleton" />
      </div>
      <div className="previous-row-footer">
        <span className="review-skeleton previous-placeholder-meta" />
      </div>
    </li>
  ));
}

export function ReviewLoadingStage() {
  return (
    <div className="review-stage route-loading-review-stage" aria-busy="true">
      <span className="sr-only" role="status">Loading Review…</span>
      <section className="question-area"><ReviewQuestionSkeleton /></section>
      <ReviewComposerSkeleton />
      <section className="previous-panel">
        <div className="previous-header">
          <h2>Previous answers</h2>
          <span className="review-skeleton review-settings-placeholder" aria-hidden="true" />
        </div>
        <ol className="previous-list"><ReviewHistorySkeleton /></ol>
      </section>
    </div>
  );
}
