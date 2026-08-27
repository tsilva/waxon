import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { removeArchivedQuestionFromView } from "../app/lib/libraryArchiveTransition.ts";
import type { V2LibraryResponse, V2Question } from "../app/lib/v2/types.ts";

const libraryPath = new URL(
  "../app/(app)/library/LibraryPageClient.tsx",
  import.meta.url,
);
const appStylesPath = new URL(
  "../app/(app)/app-globals.css",
  import.meta.url,
);

function question(
  id: string,
  lifecycle: V2Question["lifecycle"],
): V2Question {
  return {
    id,
    prompt: `${id} prompt`,
    referenceAnswer: `${id} answer`,
    lifecycle,
    flags: [],
    dueAt: null,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  };
}

test("archiving removes only the selected Library row and updates lifecycle counts", () => {
  const data: V2LibraryResponse = {
    questions: [question("active-1", "active"), question("flagged-1", "flagged")],
    counts: { active: 1, flagged: 1, archived: 2 },
  };

  const next = removeArchivedQuestionFromView(data, "active-1");

  assert.deepEqual(next.questions.map(({ id }) => id), ["flagged-1"]);
  assert.deepEqual(next.counts, { active: 0, flagged: 1, archived: 3 });
  assert.equal(
    Object.values(next.counts).reduce((total, count) => total + count, 0),
    4,
  );
  assert.deepEqual(data.counts, { active: 1, flagged: 1, archived: 2 });
  assert.deepEqual(data.questions.map(({ id }) => id), ["active-1", "flagged-1"]);
});

test("archive removal is a no-op for absent or already archived questions", () => {
  const data: V2LibraryResponse = {
    questions: [question("archived-1", "archived")],
    counts: { active: 0, flagged: 0, archived: 1 },
  };

  assert.equal(removeArchivedQuestionFromView(data, "missing"), data);
  assert.equal(removeArchivedQuestionFromView(data, "archived-1"), data);
});

test("Library archive uses an in-place fade and restores the captured scroll position", async () => {
  const [source, styles] = await Promise.all([
    readFile(libraryPath, "utf8"),
    readFile(appStylesPath, "utf8"),
  ]);

  assert.match(source, /setRemovingQuestionIds/u);
  assert.match(source, /removeArchivedQuestionFromView\(current, questionId\)/u);
  assert.match(source, /window\.scrollTo\(scrollLeft, scrollTop\)/u);
  assert.match(styles, /\.lean-question-row-removing\s*\{[^}]*opacity:\s*0;/u);
  assert.match(styles, /\.lean-question-row-removing\s*\{[^}]*pointer-events:\s*none;/u);
  assert.match(styles, /\.lean-question-row\s*\{[^}]*transition:[^}]*opacity 180ms ease/u);
});
