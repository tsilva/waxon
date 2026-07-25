"use client";

import { CircleGauge, Clock3, Layers3, LoaderCircle, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ReviewToolbar } from "@/app/ReviewToolbar";

type LearningStats = {
  activeCount: number;
  waitingNew: number;
  draftCount: number;
  dueCount: number;
  reviewsLast14Days: number;
  observedRecall: number | null;
  gradeOverrides: number;
  coveredTargets: number;
  unresolvedTargets: number;
  daily: Array<{ day: string; reviews: number; successful: number }>;
};

export default function StatsPageClient() {
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v2/stats", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as LearningStats & { error?: string };
        if (!response.ok) {
          throw new Error(body.error || "Could not load learning stats.");
        }
        setStats(body);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not load stats."),
      );
  }, []);

  const maxReviews = useMemo(
    () => Math.max(1, ...(stats?.daily.map((item) => item.reviews) ?? [1])),
    [stats?.daily],
  );

  return (
    <main className="page">
      <section className="review-shell v2-library-shell">
        <ReviewToolbar />
        <div className="v2-stats-page">
          <header className="v2-library-heading">
            <div>
              <span className="v2-kicker">Learning evidence</span>
              <h1>What your practice is protecting</h1>
              <p>
                These are outcomes from v2 graded presentations—not a gamified
                streak or a count of everything you ever saved.
              </p>
            </div>
          </header>
          {error ? <p className="v2-error">{error}</p> : null}
          {!stats ? (
            <div className="v2-empty">
              <LoaderCircle className="v2-spin" />
              <h2>Loading evidence…</h2>
            </div>
          ) : (
            <>
              <div className="v2-stat-grid">
                <article>
                  <CircleGauge />
                  <span>Observed recall · 14 days</span>
                  <strong>
                    {stats.observedRecall === null
                      ? "—"
                      : `${Math.round(stats.observedRecall * 100)}%`}
                  </strong>
                  <small>{stats.reviewsLast14Days} graded presentations</small>
                </article>
                <article>
                  <Clock3 />
                  <span>Due now</span>
                  <strong>{stats.dueCount}</strong>
                  <small>{stats.waitingNew} valid questions waiting for capacity</small>
                </article>
                <article>
                  <Layers3 />
                  <span>Active knowledge</span>
                  <strong>{stats.activeCount}</strong>
                  <small>{stats.draftCount} drafts need attention</small>
                </article>
                <article>
                  <Target />
                  <span>Audited coverage</span>
                  <strong>{stats.coveredTargets}</strong>
                  <small>{stats.unresolvedTargets} weak, missing, or unresolved targets</small>
                </article>
              </div>
              <section className="v2-stats-section">
                <div>
                  <h2>Practice over the last 14 days</h2>
                  <span>{stats.gradeOverrides} learner grade corrections</span>
                </div>
                <div className="v2-review-bars">
                  {stats.daily.length === 0 ? (
                    <p>No graded presentations yet.</p>
                  ) : (
                    stats.daily.map((item) => (
                      <div key={item.day}>
                        <span
                          style={{
                            height: `${Math.max(5, (item.reviews / maxReviews) * 100)}%`,
                          }}
                        />
                        <small>
                          {new Intl.DateTimeFormat(undefined, {
                            month: "short",
                            day: "numeric",
                          }).format(new Date(item.day))}
                        </small>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
