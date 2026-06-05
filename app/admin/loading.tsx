import Link from "next/link";
import Image from "next/image";
import type { CSSProperties } from "react";

const metricLabels = ["Total cost", "LLM calls", "Interactions", "Avg / interaction"];
const traceRows = Array.from({ length: 5 }, (_, index) => index);

export default function AdminLoading() {
  return (
    <main className="page admin-page" aria-busy="true">
      <section className="review-shell admin-shell" aria-label="Loading admin traces">
        <header className="reader-header">
          <div className="reader-heading">
            <Link className="reader-brand admin-brand-link" href="/">
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
              <Link className="reader-tab" href="/review" role="tab" aria-selected="false">
                Review
              </Link>
              <Link className="reader-tab" href="/queue" role="tab" aria-selected="false">
                Decks
              </Link>
              <span className="reader-tab reader-tab-active" role="tab" aria-selected="true">
                Admin
              </span>
            </div>
          </div>

          <div className="reader-actions">
            <span className="queue-summary">149 due</span>
            <span className="user-menu-trigger admin-skeleton-avatar" aria-hidden="true" />
          </div>
        </header>

        <div className="admin-stage admin-loading-stage">
          <section className="admin-heading-row">
            <div>
              <p className="admin-kicker">Observability</p>
              <h1>Admin traces</h1>
              <p>LLM activity grouped by user interaction.</p>
            </div>
            <div className="admin-range-controls" aria-hidden="true">
              <span className="admin-skeleton-control admin-skeleton-segmented" />
              <span className="admin-skeleton-control" />
              <span className="admin-skeleton-control" />
              <span className="admin-skeleton-refresh" />
            </div>
          </section>

          <section className="admin-metrics" aria-label="Loading range totals">
            {metricLabels.map((label) => (
              <div className="admin-skeleton-metric" key={label}>
                <span>{label}</span>
                <strong className="admin-skeleton-line admin-skeleton-line-large" />
                <small className="admin-skeleton-line admin-skeleton-line-small" />
              </div>
            ))}
          </section>

          <section className="admin-chart-panel" aria-labelledby="admin-loading-cost-heading">
            <div className="admin-section-heading">
              <div>
                <h2 id="admin-loading-cost-heading">Cost per day</h2>
                <p>Stratified by call type.</p>
              </div>
              <div className="admin-legend" aria-hidden="true">
                {["answer eval", "question generation", "embedding", "summarization"].map(
                  (label) => (
                    <span className="admin-skeleton-legend" key={label}>
                      <i />
                      {label}
                    </span>
                  ),
                )}
              </div>
            </div>
            <div className="admin-chart-scroll" aria-hidden="true">
              <div className="admin-cost-chart admin-skeleton-chart">
                {Array.from({ length: 8 }, (_, index) => (
                  <span
                    className="admin-skeleton-bar"
                    key={index}
                    style={
                      {
                        "--bar-height": `${38 + ((index * 17) % 72)}%`,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="admin-table-panel" aria-labelledby="admin-loading-table-heading">
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

            <div className="admin-table-scroll" aria-hidden="true">
              <div className="admin-trace-table admin-skeleton-table" role="presentation">
                <div className="admin-trace-header" role="presentation">
                  <span>Interaction</span>
                  <span>Started</span>
                  <span>Calls</span>
                  <span>Tokens</span>
                  <span>Cost</span>
                  <span>Latency</span>
                  <span>Status</span>
                </div>
                {traceRows.map((row) => (
                  <div className="admin-trace-group" key={row}>
                    <div className="admin-trace-row">
                      <span className="admin-skeleton-stack">
                        <span className="admin-skeleton-line admin-skeleton-title" />
                        <span className="admin-skeleton-line admin-skeleton-meta" />
                      </span>
                      <span className="admin-skeleton-line" />
                      <span className="admin-skeleton-line" />
                      <span className="admin-skeleton-line" />
                      <span className="admin-skeleton-line" />
                      <span className="admin-skeleton-line" />
                      <span className="admin-skeleton-pill" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
