import assert from "node:assert/strict";
import test from "node:test";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";
import { planQuestionTargetKeyUpdates } from "../scripts/question-target-key-backfill.mts";

test("target-key repair prefers an already-canonical active question", () => {
  const prompt = "What is the average-case complexity of bubble sort?";
  const desiredKey = questionPromptKey(prompt);
  const updates = planQuestionTargetKeyUpdates([
    {
      id: "older-stale",
      userId: "learner",
      lifecycle: "new",
      targetKey: "legacy-concept-key",
      prompt,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: "already-canonical",
      userId: "learner",
      lifecycle: "review",
      targetKey: desiredKey,
      prompt,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
    {
      id: "archived-copy",
      userId: "learner",
      lifecycle: "archived",
      targetKey: "legacy-archived-key",
      prompt,
      createdAt: new Date("2026-03-01T00:00:00Z"),
    },
  ]);

  assert.equal(updates.some((update) => update.id === "already-canonical"), false);
  assert.equal(
    updates.find((update) => update.id === "archived-copy")?.targetKey,
    desiredKey,
  );
  const duplicate = updates.find((update) => update.id === "older-stale");
  assert.notEqual(duplicate?.targetKey, desiredKey);
  assert.match(duplicate?.targetKey ?? "", /older-stale$/);
});

test("target-key repair assigns the normalized prompt key to a unique legacy row", () => {
  const prompt = "  WHAT\n does  FSRS schedule? ";
  const updates = planQuestionTargetKeyUpdates([
    {
      id: "legacy",
      userId: "learner",
      lifecycle: "learning",
      targetKey: "old-target-key",
      prompt,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ]);

  assert.deepEqual(updates, [
    {
      id: "legacy",
      userId: "learner",
      lifecycle: "learning",
      targetKey: questionPromptKey(prompt),
    },
  ]);
});
