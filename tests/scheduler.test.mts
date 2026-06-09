import assert from "node:assert/strict";
import test from "node:test";
import { DAY, scheduleNextReview } from "../app/lib/scheduler.ts";

test("scheduleNextReview keeps low-scoring answers due immediately for same-session repeats", () => {
  const now = 1_800_000_000_000;

  for (const score of [0, 1, 3, 4, 5, 6, 7, 8]) {
    assert.equal(
      scheduleNextReview({
        previousReviews: [],
        newScore: score,
        now,
      }),
      now,
    );
  }
});

test("scheduleNextReview uses day-scale schedules for excellent answers", () => {
  const now = 1_800_000_000_000;

  const scoreNineNextDue = scheduleNextReview({
    previousReviews: [],
    newScore: 9,
    now,
  });
  const scoreTenNextDue = scheduleNextReview({
    previousReviews: [],
    newScore: 10,
    now,
  });

  assert.ok(scoreNineNextDue - now >= 3 * DAY);
  assert.ok(scoreTenNextDue - now >= 7 * DAY);
});
