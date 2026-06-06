import assert from "node:assert/strict";
import test from "node:test";
import { questionSlug } from "../app/lib/questionSlug.ts";

test("questionSlug keeps ASCII slugs stable", () => {
  assert.equal(
    questionSlug("What does cross entropy penalize?"),
    "what-does-cross-entropy-penalize",
  );
});

test("questionSlug distinguishes questions that differ by non-ASCII content", () => {
  const first = questionSlug("What is the reading of あ?");
  const second = questionSlug("What is the reading of い?");

  assert.notEqual(first, second);
  assert.match(first, /^what-is-the-reading-of-[a-f0-9]{8}$/);
  assert.match(second, /^what-is-the-reading-of-[a-f0-9]{8}$/);
});
