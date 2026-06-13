import type { CSSProperties } from "react";

const adminSkeletonMetricRows = Array.from({ length: 4 }, (_, index) => index);
const adminSkeletonChartBars = [68, 118, 88, 154, 104, 132, 78];
const adminSkeletonTableRows = Array.from({ length: 6 }, (_, index) => index);
const callTypeLabels = [
  "answer eval",
  "question generation",
  "embedding",
  "summarization",
];

export default function AdminLoading() {
  return (
    <main className="page admin-page">
      <section className="review-shell admin-shell" aria-label="Loading admin traces">
        <header className="reader-header" aria-label="Loading Waxon views">
          <div className="reader-heading">
            <div className="reader-brand admin-brand-link" aria-hidden="true">
              <span className="reader-brand-mark admin-skeleton-brand-mark" />
              <span>waxon</span>
            </div>
            <div className="reader-tabs" aria-hidden="true">
              <span className="reader-tab">Review</span>
              <span className="reader-tab">Learn</span>
              <span className="reader-tab">Library</span>
              <span className="reader-tab">Tags</span>
              <span className="reader-tab reader-tab-active">Admin</span>
            </div>
          </div>

          <div className="reader-actions" aria-hidden="true">
            <span className="queue-summary">0 due</span>
            <span className="user-menu-trigger admin-skeleton-avatar" />
          </div>
        </header>

        <div className="admin-stage">
          <section className="admin-heading-row">
            <div>
              <p className="admin-kicker">Observability</p>
              <h1>LLM trace dashboard</h1>
              <p>Loading recent model calls, costs, latency, and payloads.</p>
            </div>
            <div className="admin-range-controls" aria-hidden="true">
              <span className="admin-skeleton-control admin-skeleton-segmented" />
              <span className="admin-skeleton-control" />
              <span className="admin-skeleton-control" />
              <span className="admin-skeleton-refresh" />
            </div>
          </section>

          <div
            className="admin-loading-stage"
            aria-busy="true"
            aria-label="Loading admin traces"
          >
            <section
              className="admin-metrics"
              aria-label="Loading current range totals"
            >
              {adminSkeletonMetricRows.map((row) => (
                <div className="admin-skeleton-metric" key={row}>
                  <span className="admin-skeleton-line admin-skeleton-line-small" />
                  <span className="admin-skeleton-line admin-skeleton-line-large" />
                  <span className="admin-skeleton-line admin-skeleton-line-small" />
                </div>
              ))}
            </section>

            <section
              className="admin-chart-panel"
              aria-labelledby="admin-loading-cost-heading"
            >
              <div className="admin-section-heading">
                <div>
                  <h2 id="admin-loading-cost-heading">Cost per day</h2>
                  <p>Stratified by call type.</p>
                </div>
                <div
                  className="admin-legend admin-skeleton-legend"
                  aria-hidden="true"
                >
                  {callTypeLabels.map((callType) => (
                    <span key={callType}>
                      <i />
                      {callType}
                    </span>
                  ))}
                </div>
              </div>
              <div className="admin-chart-scroll">
                <div className="admin-cost-chart admin-skeleton-chart">
                  {adminSkeletonChartBars.map((height, index) => (
                    <span
                      className="admin-skeleton-bar"
                      key={`${height}-${index}`}
                      style={{ "--bar-height": `${height}px` } as CSSProperties}
                    />
                  ))}
                </div>
              </div>
            </section>

            <section
              className="admin-table-panel"
              aria-labelledby="admin-loading-table-heading"
            >
              <div className="admin-section-heading admin-table-heading">
                <div>
                  <h2 id="admin-loading-table-heading">Trace groups</h2>
                  <p>Expand an interaction to inspect the individual LLM calls.</p>
                </div>
                <div className="admin-filter-row" aria-hidden="true">
                  <span className="admin-skeleton-filter" />
                  <span className="admin-skeleton-filter" />
                  <span className="admin-skeleton-search" />
                </div>
              </div>

              <div className="admin-table-scroll">
                <div
                  className="admin-trace-table admin-skeleton-table"
                  role="table"
                  aria-label="Loading trace groups"
                >
                  <div className="admin-trace-header" role="row">
                    <span role="columnheader">Interaction</span>
                    <span role="columnheader">Started</span>
                    <span role="columnheader">Calls</span>
                    <span role="columnheader">Tokens</span>
                    <span role="columnheader">Cost</span>
                    <span role="columnheader">Latency</span>
                    <span role="columnheader">Status</span>
                  </div>

                  {adminSkeletonTableRows.map((row) => (
                    <div className="admin-trace-group" key={row} role="rowgroup">
                      <div className="admin-trace-row" role="row">
                        <span className="admin-skeleton-stack">
                          <span className="admin-skeleton-line admin-skeleton-title" />
                          <span className="admin-skeleton-line admin-skeleton-meta" />
                        </span>
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                        <span className="admin-skeleton-pill" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
