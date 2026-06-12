"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { DAY } from "@/app/lib/scheduler";
import type { StatsResponse } from "@/app/lib/stats";
import { ReviewToolbar } from "@/app/ReviewToolbar";

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type StatsPageClientProps = {
  currentUser?: UserProfileResponse | null;
  showAdmin?: boolean;
  stats?: StatsResponse | null;
};

type DailyCountBucket = {
  dayStart: number;
  label: string;
  value: number;
};

type DailyScoreBucket = DailyCountBucket & {
  averageScore: number | null;
};

type DailyQueueEstimateBucket = {
  dayStart: number;
  label: string;
  scheduledValue: number;
  estimatedQueue: number;
};

type StatsAnalytics = {
  scheduledBuckets: DailyCountBucket[];
  processedBuckets: DailyScoreBucket[];
  estimatedQueueBuckets: DailyQueueEstimateBucket[];
  scheduledTotal: number;
  processedTotal: number;
  averageScore: number | null;
};

function createEmptyStats(): StatsResponse {
  return {
    now: Date.now(),
    dueCount: 0,
    cardCount: 0,
    scheduledBuckets: [],
    processedBuckets: [],
  };
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

function formatStatsDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function createDailyBuckets(startDay: number): DailyCountBucket[] {
  return Array.from({ length: 14 }, (_, index) => {
    const dayStart = startDay + index * DAY;

    return {
      dayStart,
      label: formatStatsDate(dayStart),
      value: 0,
    };
  });
}

function buildStatsAnalytics(stats: StatsResponse): StatsAnalytics {
  const todayStart = startOfLocalDay(stats.now);
  const scheduledBuckets = createDailyBuckets(todayStart);
  const processedBuckets: DailyScoreBucket[] = createDailyBuckets(
    todayStart - 13 * DAY,
  ).map((bucket) => ({
    ...bucket,
    averageScore: null,
  }));
  const scoreTotals = processedBuckets.map(() => ({ total: 0, count: 0 }));
  const scheduledBucketIndex = new Map(
    scheduledBuckets.map((bucket, index) => [bucket.dayStart, index]),
  );
  const processedBucketIndex = new Map(
    processedBuckets.map((bucket, index) => [bucket.dayStart, index]),
  );

  for (const item of stats.scheduledBuckets) {
    if (!Number.isFinite(item.dayStart) || !Number.isFinite(item.value)) {
      continue;
    }

    const index = scheduledBucketIndex.get(startOfLocalDay(item.dayStart));

    if (index !== undefined) {
      scheduledBuckets[index].value += item.value;
    }
  }

  for (const item of stats.processedBuckets) {
    if (
      !Number.isFinite(item.dayStart) ||
      !Number.isFinite(item.value) ||
      !Number.isFinite(item.averageScore)
    ) {
      continue;
    }

    const index = processedBucketIndex.get(startOfLocalDay(item.dayStart));

    if (index !== undefined) {
      processedBuckets[index].value += item.value;
      scoreTotals[index].total += item.averageScore * item.value;
      scoreTotals[index].count += item.value;
    }
  }

  processedBuckets.forEach((bucket, index) => {
    const scoreTotal = scoreTotals[index];

    bucket.averageScore =
      scoreTotal.count > 0 ? scoreTotal.total / scoreTotal.count : null;
  });

  let estimatedQueue = 0;
  const estimatedQueueBuckets = scheduledBuckets.map((bucket) => {
    estimatedQueue += bucket.value;

    return {
      dayStart: bucket.dayStart,
      label: bucket.label,
      scheduledValue: bucket.value,
      estimatedQueue,
    };
  });
  const processedTotal = scoreTotals.reduce(
    (total, item) => total + item.count,
    0,
  );
  const scoreTotal = scoreTotals.reduce((total, item) => total + item.total, 0);

  return {
    scheduledBuckets,
    processedBuckets,
    estimatedQueueBuckets,
    scheduledTotal: scheduledBuckets.reduce(
      (total, item) => total + item.value,
      0,
    ),
    processedTotal,
    averageScore: processedTotal > 0 ? scoreTotal / processedTotal : null,
  };
}

function DailyBarChart({
  buckets,
  ariaLabel,
}: {
  buckets: DailyCountBucket[];
  ariaLabel: string;
}) {
  const width = 720;
  const height = 190;
  const paddingX = 34;
  const paddingTop = 24;
  const paddingBottom = 34;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingTop - paddingBottom;
  const maxValue = Math.max(1, ...buckets.map((bucket) => bucket.value));
  const barGap = 9;
  const barWidth = Math.max(
    8,
    (plotWidth - barGap * (buckets.length - 1)) / buckets.length,
  );

  return (
    <svg
      className="daily-stats-chart daily-stats-bar-chart"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0, 0.5, 1].map((ratio) => (
        <line
          className="daily-stats-grid-line"
          key={ratio}
          x1={paddingX}
          x2={width - paddingX}
          y1={paddingTop + plotHeight * ratio}
          y2={paddingTop + plotHeight * ratio}
        />
      ))}
      {buckets.map((bucket, index) => {
        const barHeight = (bucket.value / maxValue) * plotHeight;
        const x = paddingX + index * (barWidth + barGap);
        const y = paddingTop + plotHeight - barHeight;
        const shouldLabel =
          index === 0 || index === buckets.length - 1 || index % 3 === 0;

        return (
          <g key={bucket.dayStart}>
            <rect
              className="daily-stats-bar"
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(2, barHeight)}
              rx="4"
            />
            {bucket.value > 0 ? (
              <text className="daily-stats-value" x={x + barWidth / 2} y={y - 7}>
                {bucket.value}
              </text>
            ) : null}
            {shouldLabel ? (
              <text
                className="daily-stats-axis"
                x={x + barWidth / 2}
                y={height - 8}
              >
                {bucket.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function EstimatedQueueList({
  buckets,
}: {
  buckets: DailyQueueEstimateBucket[];
}) {
  return (
    <ol className="estimated-queue-list" aria-label="Estimated review queue by day">
      {buckets.map((bucket, index) => (
        <li className="estimated-queue-row" key={bucket.dayStart}>
          <span className="estimated-queue-date">
            {index === 0 ? "Today" : bucket.label}
          </span>
          <span className="estimated-queue-due">
            {bucket.scheduledValue} due
          </span>
          <strong className="estimated-queue-count">
            {bucket.estimatedQueue}
          </strong>
        </li>
      ))}
    </ol>
  );
}

function DailyScoreChart({ buckets }: { buckets: DailyScoreBucket[] }) {
  const width = 720;
  const height = 190;
  const paddingX = 34;
  const paddingTop = 24;
  const paddingBottom = 34;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingTop - paddingBottom;
  const points = buckets
    .map((bucket, index) => {
      if (bucket.averageScore === null) {
        return null;
      }

      const x =
        buckets.length === 1
          ? paddingX + plotWidth / 2
          : paddingX + (index / (buckets.length - 1)) * plotWidth;
      const y = paddingTop + ((10 - bucket.averageScore) / 10) * plotHeight;

      return { ...bucket, x, y };
    })
    .filter(
      (
        point,
      ): point is DailyScoreBucket & {
        x: number;
        y: number;
        averageScore: number;
      } => point !== null,
    );
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  if (points.length === 0) {
    return (
      <div className="daily-stats-empty">
        Average score will appear after reviews are processed.
      </div>
    );
  }

  return (
    <svg
      className="daily-stats-chart daily-stats-line-chart"
      role="img"
      aria-label="Average score per day"
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0, 0.5, 1].map((ratio) => (
        <line
          className="daily-stats-grid-line"
          key={ratio}
          x1={paddingX}
          x2={width - paddingX}
          y1={paddingTop + plotHeight * ratio}
          y2={paddingTop + plotHeight * ratio}
        />
      ))}
      <text className="daily-stats-axis daily-stats-y-axis" x="14" y={paddingTop + 4}>
        10
      </text>
      <text
        className="daily-stats-axis daily-stats-y-axis"
        x="18"
        y={height - paddingBottom + 4}
      >
        0
      </text>
      {path ? <path className="daily-stats-line" d={path} /> : null}
      {points.map((point) => (
        <g key={point.dayStart}>
          <circle className="daily-stats-point" cx={point.x} cy={point.y} r="5" />
          <text className="daily-stats-value" x={point.x} y={point.y - 10}>
            {point.averageScore.toFixed(1)}
          </text>
        </g>
      ))}
      {buckets.map((bucket, index) => {
        if (!(index === 0 || index === buckets.length - 1 || index % 3 === 0)) {
          return null;
        }

        const x =
          buckets.length === 1
            ? paddingX + plotWidth / 2
            : paddingX + (index / (buckets.length - 1)) * plotWidth;

        return (
          <text className="daily-stats-axis" key={bucket.dayStart} x={x} y={height - 8}>
            {bucket.label}
          </text>
        );
      })}
    </svg>
  );
}

function StatsDashboardSkeleton() {
  return (
    <div className="stats-page-chart-grid" aria-label="Loading review stats">
      {["Scheduled per day", "Estimated queue by day", "Processed per day", "Average score per day"].map(
        (title, index) => (
          <section
            className={`stats-page-chart-panel ${
              index % 2 === 1 ? "stats-page-chart-panel-wide" : ""
            }`}
            key={title}
          >
            <div className="stats-section-heading">
              <div className="admin-skeleton-stack">
                <span className="admin-skeleton-line stats-skeleton-heading" />
                <span className="admin-skeleton-line stats-skeleton-subheading" />
              </div>
            </div>
            <div className="stats-skeleton-chart">
              {Array.from({ length: 9 }, (_, barIndex) => (
                <span
                  className="admin-skeleton-bar"
                  key={barIndex}
                  style={
                    {
                      "--bar-height": `${48 + ((barIndex * 37) % 126)}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}

export default function StatsPageClient({
  currentUser: initialCurrentUser = null,
  showAdmin = false,
  stats: initialStats = null,
}: StatsPageClientProps) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const isLocalAuth = isLocalTestAuthEnabled();
  const [currentUser, setCurrentUser] = useState(initialCurrentUser);
  const [stats, setStats] = useState(initialStats);
  const [isStatsLoading, setIsStatsLoading] = useState(initialStats === null);
  const [statsMessage, setStatsMessage] = useState<string | null>(null);
  const emptyStats = useMemo(() => createEmptyStats(), []);
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const renderedStats = stats ?? emptyStats;
  const statsAnalytics = useMemo(
    () => buildStatsAnalytics(renderedStats),
    [renderedStats],
  );
  const canViewAdmin =
    showAdmin ||
    isAdminEmail(
      clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email,
    );
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;

    async function loadStatsPageData() {
      setIsStatsLoading(true);
      setStatsMessage(null);

      try {
        const [userResponse, statsResponse] = await Promise.all([
          fetch("/api/user", { cache: "no-store", signal: controller.signal }),
          fetch("/api/stats", { cache: "no-store", signal: controller.signal }),
        ]);
        const userData = (await userResponse.json()) as UserProfileResponse & {
          error?: string;
        };
        const statsData = (await statsResponse.json()) as StatsResponse & {
          error?: string;
        };

        if (!userResponse.ok) {
          throw new Error(userData.error || "Could not load profile.");
        }

        if (!statsResponse.ok) {
          throw new Error(statsData.error || "Could not load stats.");
        }

        if (isActive) {
          setCurrentUser(userData);
          setStats(statsData);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (isActive) {
          setStatsMessage(
            error instanceof Error ? error.message : "Could not load stats.",
          );
        }
      } finally {
        if (isActive) {
          setIsStatsLoading(false);
        }
      }
    }

    void loadStatsPageData();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, []);

  return (
    <main className="page">
      <section className="review-shell" aria-label="Review statistics">
        <ReviewToolbar
          activeTab="stats"
          dueCount={renderedStats.dueCount}
          showAdmin={canViewAdmin}
          menuAvatarUrl={menuAvatarUrl}
          menuDisplayName={menuDisplayName}
          menuEmail={menuEmail}
          onManageAccount={() => {
            if (!isLocalAuth) {
              clerk.openUserProfile({
                customPages: accountWidgetsCustomPages,
              });
            }
          }}
          onSignOut={() => {
            if (isLocalAuth) {
              window.location.assign("/");
            } else {
              void clerk.signOut({ redirectUrl: "/" });
            }
          }}
        />

        <section className="stats-stage" aria-label="Review statistics">
          <div className="stats-page-header">
            <div>
              <p className="stats-page-kicker">Review stats</p>
              <h2>Stats</h2>
            </div>
          </div>

          <dl className="stats-page-summary" aria-label="Review summary">
            <div>
              <dt>
                {isStatsLoading && stats === null ? (
                  <span className="admin-skeleton-line stats-skeleton-number" />
                ) : (
                  renderedStats.dueCount
                )}
              </dt>
              <dd>due now</dd>
            </div>
            <div>
              <dt>
                {isStatsLoading && stats === null ? (
                  <span className="admin-skeleton-line stats-skeleton-number" />
                ) : (
                  statsAnalytics.scheduledTotal
                )}
              </dt>
              <dd>scheduled 14d</dd>
            </div>
            <div>
              <dt>
                {isStatsLoading && stats === null ? (
                  <span className="admin-skeleton-line stats-skeleton-number" />
                ) : (
                  statsAnalytics.processedTotal
                )}
              </dt>
              <dd>processed 14d</dd>
            </div>
            <div>
              <dt>
                {isStatsLoading && stats === null ? (
                  <span className="admin-skeleton-line stats-skeleton-number" />
                ) : statsAnalytics.averageScore === null
                  ? "-"
                  : statsAnalytics.averageScore.toFixed(1)}
              </dt>
              <dd>avg score</dd>
            </div>
          </dl>

          {statsMessage ? (
            <p className="stats-page-status">{statsMessage}</p>
          ) : null}

          {isStatsLoading && stats === null ? (
            <StatsDashboardSkeleton />
          ) : (
            <div className="stats-page-chart-grid">
            <section className="stats-page-chart-panel">
              <div className="stats-section-heading">
                <h3>Scheduled per day</h3>
                <span>Next 14 days</span>
              </div>
              <DailyBarChart
                buckets={statsAnalytics.scheduledBuckets}
                ariaLabel="Scheduled reviews per day for the next 14 days"
              />
            </section>

            <section className="stats-page-chart-panel stats-page-chart-panel-wide">
              <div className="stats-section-heading">
                <h3>Estimated queue by day</h3>
                <span>Next 14 days</span>
              </div>
              <EstimatedQueueList
                buckets={statsAnalytics.estimatedQueueBuckets}
              />
            </section>

            <section className="stats-page-chart-panel">
              <div className="stats-section-heading">
                <h3>Processed per day</h3>
                <span>Last 14 days</span>
              </div>
              <DailyBarChart
                buckets={statsAnalytics.processedBuckets}
                ariaLabel="Processed reviews per day for the last 14 days"
              />
            </section>

            <section className="stats-page-chart-panel stats-page-chart-panel-wide">
              <div className="stats-section-heading">
                <h3>Average score per day</h3>
                <span>Last 14 days</span>
              </div>
              <DailyScoreChart buckets={statsAnalytics.processedBuckets} />
            </section>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
