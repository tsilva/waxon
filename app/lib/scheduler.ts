export type ReviewEntry = {
  ts: number;
  score: number;
};

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const MAX_SUCCESS_INTERVAL = 365 * DAY;
export const SCHEDULED_SCORE_THRESHOLD = 9;

const IMMEDIATE_RETRY_SCORE_MAX = 5;
const PARTIAL_RECALL_INTERVAL = DAY;
const FIRST_STRONG_RECALL_INTERVAL = DAY;
const FIRST_EXCELLENT_RECALL_INTERVAL = 3 * DAY;
const FIRST_EXCELLENT_RECALL_AFTER_FAILURE_INTERVAL = 2 * DAY;
const RECENT_FAILURE_LOOKBACK = 3;
const RECENT_FAILURE_INTERVAL_PENALTY = 0.5;

export function parseReviews(reviews: string): ReviewEntry[] {
  if (!reviews.trim()) {
    return [];
  }

  return reviews
    .split("|")
    .map((entry) => {
      const [ts, score] = entry.split(":");
      return {
        ts: Number(ts),
        score: Number(score),
      };
    })
    .filter(
      (entry) =>
        Number.isFinite(entry.ts) &&
        Number.isFinite(entry.score) &&
        entry.ts > 0 &&
        entry.score >= 0 &&
        entry.score <= 10,
    );
}

export function serializeReviews(entries: ReviewEntry[]): string {
  return entries.map((entry) => `${entry.ts}:${entry.score}`).join("|");
}

export function scheduleNextReview(input: {
  previousReviews: ReviewEntry[];
  newScore: number;
  now: number;
}): number {
  const { previousReviews, newScore, now } = input;
  const previousReview = previousReviews.at(-1);

  if (newScore <= IMMEDIATE_RETRY_SCORE_MAX) {
    return now;
  }

  if (newScore < SCHEDULED_SCORE_THRESHOLD) {
    return now + PARTIAL_RECALL_INTERVAL;
  }

  const latestReviewWasSuccess =
    previousReview !== undefined &&
    previousReview.score >= SCHEDULED_SCORE_THRESHOLD;
  const hasRecentFailure = previousReviews
    .slice(-RECENT_FAILURE_LOOKBACK)
    .some((entry) => entry.score <= IMMEDIATE_RETRY_SCORE_MAX);

  if (!latestReviewWasSuccess) {
    if (newScore === 9) {
      return now + FIRST_STRONG_RECALL_INTERVAL;
    }

    return (
      now +
      (hasRecentFailure
        ? FIRST_EXCELLENT_RECALL_AFTER_FAILURE_INTERVAL
        : FIRST_EXCELLENT_RECALL_INTERVAL)
    );
  }

  const previousInterval = Math.max(now - previousReview.ts, DAY);
  const successIntervals: Record<number, { multiplier: number; minimum: number }> =
    {
      9: {
        multiplier: 3,
        minimum: FIRST_STRONG_RECALL_INTERVAL,
      },
      10: {
        multiplier: 5,
        minimum: hasRecentFailure
          ? FIRST_EXCELLENT_RECALL_AFTER_FAILURE_INTERVAL
          : FIRST_EXCELLENT_RECALL_INTERVAL,
      },
    };

  const successInterval = successIntervals[newScore];
  if (!successInterval) {
    return now + DAY;
  }

  const adjustedInterval =
    previousInterval *
    successInterval.multiplier *
    (hasRecentFailure ? RECENT_FAILURE_INTERVAL_PENALTY : 1);

  return (
    now +
    Math.min(
      Math.max(successInterval.minimum, adjustedInterval),
      MAX_SUCCESS_INTERVAL,
    )
  );
}
