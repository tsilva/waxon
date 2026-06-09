export type ReviewEntry = {
  ts: number;
  score: number;
};

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const MAX_SUCCESS_INTERVAL = 365 * DAY;
export const SCHEDULED_SCORE_THRESHOLD = 9;

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
  const previousInterval = previousReview ? now - previousReview.ts : DAY;

  if (newScore < SCHEDULED_SCORE_THRESHOLD) {
    return now;
  }

  const successIntervals: Record<number, number> = {
    9: Math.max(3 * DAY, previousInterval * 3),
    10: Math.max(7 * DAY, previousInterval * 5),
  };

  return now + Math.min(successIntervals[newScore] ?? DAY, MAX_SUCCESS_INTERVAL);
}
