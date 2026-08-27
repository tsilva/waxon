import assert from "node:assert/strict";
import test from "node:test";
import { reviewIntervalLabel } from "../app/lib/reviewIntervalLabel.ts";

const now = new Date(2026, 7, 27, 12);
const options = { locale: "en", now } as const;

test("reviewIntervalLabel uses relative units for future local calendar days", () => {
  assert.equal(reviewIntervalLabel("2026-08-28", options), "Review in 1 day");
  assert.equal(reviewIntervalLabel("2026-09-10", options), "Review in 2 weeks");
  assert.equal(reviewIntervalLabel("2026-10-27", options), "Review in 2 months");
  assert.equal(reviewIntervalLabel("2028-08-27", options), "Review in 2 years");
});

test("reviewIntervalLabel says now when due or overdue", () => {
  assert.equal(reviewIntervalLabel("2026-08-27", options), "Review now");
  assert.equal(reviewIntervalLabel("2026-08-20", options), "Review now");
});

test("reviewIntervalLabel rejects absent or invalid calendar days", () => {
  assert.equal(reviewIntervalLabel(null, options), null);
  assert.equal(reviewIntervalLabel("2026-02-30", options), null);
  assert.equal(reviewIntervalLabel("not-a-date", options), null);
});
