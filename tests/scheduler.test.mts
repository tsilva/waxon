import assert from "node:assert/strict";
import test from "node:test";
import { DAY, scheduleNextReview } from "../app/lib/scheduler.ts";

test("scheduleNextReview keeps low-scoring answers due immediately for same-session repeats", () => {
  const now = 1_800_000_000_000;

  for (const score of [0, 1, 3, 4, 5]) {
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

test("scheduleNextReview schedules partial recall for the next day", () => {
  const now = 1_800_000_000_000;

  for (const score of [6, 7, 8]) {
    assert.equal(
      scheduleNextReview({
        previousReviews: [],
        newScore: score,
        now,
      }),
      now + DAY,
    );
  }
});

test("scheduleNextReview uses shorter first-success schedules", () => {
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

  assert.equal(scoreNineNextDue, now + DAY);
  assert.equal(scoreTenNextDue, now + 3 * DAY);
});

test("scheduleNextReview penalizes excellent relearning after a recent failure", () => {
  const now = 1_800_000_000_000;

  assert.equal(
    scheduleNextReview({
      previousReviews: [{ ts: now - 5 * 60 * 1000, score: 4 }],
      newScore: 10,
      now,
    }),
    now + 2 * DAY,
  );
});

test("scheduleNextReview grows mature success intervals from the previous successful review", () => {
  const now = 1_800_000_000_000;

  assert.equal(
    scheduleNextReview({
      previousReviews: [{ ts: now - 4 * DAY, score: 9 }],
      newScore: 9,
      now,
    }),
    now + 12 * DAY,
  );

  assert.equal(
    scheduleNextReview({
      previousReviews: [{ ts: now - 4 * DAY, score: 10 }],
      newScore: 10,
      now,
    }),
    now + 20 * DAY,
  );
});

test("scheduleNextReview caps mature growth and applies recent failure penalty", () => {
  const now = 1_800_000_000_000;

  assert.equal(
    scheduleNextReview({
      previousReviews: [
        { ts: now - 4 * DAY, score: 4 },
        { ts: now - 2 * DAY, score: 10 },
      ],
      newScore: 10,
      now,
    }),
    now + 5 * DAY,
  );

  assert.equal(
    scheduleNextReview({
      previousReviews: [{ ts: now - 400 * DAY, score: 10 }],
      newScore: 10,
      now,
    }),
    now + 365 * DAY,
  );
});
