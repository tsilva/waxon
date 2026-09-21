import assert from "node:assert/strict";
import test from "node:test";
import { formatLibraryDueDate } from "../app/lib/libraryDueDate.ts";

test("same-day countdown advances and becomes due without negative time", () => {
  const due = new Date(2026, 8, 21, 16, 13).toISOString();
  assert.equal(formatLibraryDueDate(due, new Date(2026, 8, 21, 13)), "3h13m from now");
  assert.equal(formatLibraryDueDate(due, new Date(2026, 8, 21, 13, 1)), "3h12m from now");
  assert.equal(formatLibraryDueDate(due, new Date(2026, 8, 21, 16, 12, 59)), "1m from now");
  assert.equal(formatLibraryDueDate(due, new Date(2026, 8, 21, 16, 13)), "Due now");
  assert.equal(formatLibraryDueDate(due, new Date(2026, 8, 22)), "Due now");
});

test("countdown continues across local midnight", () => {
  const due = new Date(2026, 8, 22, 3, 13);
  assert.equal(
    formatLibraryDueDate(due.toISOString(), new Date(2026, 8, 21, 23, 59)),
    "3h14m from now",
  );
  assert.equal(formatLibraryDueDate(due.toISOString(), new Date(2026, 8, 22)), "3h13m from now");
});

test("uses relative days through exactly seven days, then calendar dates", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const day = 86_400_000;
  for (const days of [1, 3, 7]) {
    const due = new Date(now.getTime() + days * day);
    assert.equal(formatLibraryDueDate(due.toISOString(), now), `${days} ${days === 1 ? "day" : "days"} from now`);
  }
  const due = new Date(now.getTime() + 7 * day + 1);
  assert.equal(formatLibraryDueDate(due.toISOString(), now), new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(due));
  assert.equal(formatLibraryDueDate(due.toISOString(), new Date(now.getTime() + 1)), "7 days from now");
  assert.equal(formatLibraryDueDate(new Date(now.getTime() + day - 60_000).toISOString(), now), "23h59m from now");
});
