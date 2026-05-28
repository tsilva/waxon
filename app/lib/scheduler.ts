export type ReviewEntry = {
  ts: number;
  score: number;
};

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const MAX_SUCCESS_INTERVAL = 365 * DAY;

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

export function appendReview(
  reviews: string,
  entry: ReviewEntry,
  maxEntries = 10,
): string {
  return serializeReviews([...parseReviews(reviews), entry].slice(-maxEntries));
}

export function scheduleNextReview(input: {
  previousReviews: ReviewEntry[];
  newScore: number;
  now: number;
}): number {
  const { previousReviews, newScore, now } = input;
  const previousReview = previousReviews.at(-1);
  const previousInterval = previousReview ? now - previousReview.ts : DAY;

  if (newScore <= 3) {
    return now + MINUTE;
  }

  if (newScore <= 5) {
    return now + 3 * MINUTE;
  }

  if (newScore === 6) {
    return now + 15 * MINUTE;
  }

  const successIntervals: Record<number, number> = {
    7: Math.max(DAY, previousInterval * 1.2),
    8: Math.max(2 * DAY, previousInterval * 2),
    9: Math.max(4 * DAY, previousInterval * 3),
    10: Math.max(7 * DAY, previousInterval * 5),
  };

  return now + Math.min(successIntervals[newScore] ?? DAY, MAX_SUCCESS_INTERVAL);
}

export function reinsertionDelay(score: number): number | null {
  if (score <= 3) {
    return 1;
  }

  if (score <= 5) {
    return 3;
  }

  if (score === 6) {
    return 8;
  }

  return null;
}

