import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredReviewRetryQuestionIds,
  mergeDeferredReviewRetryItem,
  placeReviewRetryQuestion,
  releaseDeferredReviewRetries,
} from "../app/lib/reviewRetryQueue.ts";
import type { ReviewQueueItem } from "../app/lib/reviewTypes.ts";

function reviewItem(id: string, question = `Question ${id}`): ReviewQueueItem {
  return {
    questionId: id,
    question,
    nextDue: 0,
    createdAt: 0,
    msUntilDue: 0,
    status: "now",
    generatedFromQuestion: null,
    questionProvenance: null,
    reviewHistory: [],
    lastScore: null,
    lastAnswer: null,
    lastAnswerSummary: null,
    conciseAnswer: null,
    referenceAnswer: null,
    lastJustification: null,
    attempts: [],
    conceptSlugs: [],
  };
}

test("placeReviewRetryQuestion defers retry when it would be shown immediately", () => {
  const retryItem = reviewItem("failed");
  const result = placeReviewRetryQuestion({
    retryItem,
    currentItem: null,
    queue: [],
  });

  assert.deepEqual(result.queue, []);
  assert.equal(result.deferredRetryItem, retryItem);
});

test("placeReviewRetryQuestion queues retry after an active different question", () => {
  const retryItem = reviewItem("failed");
  const result = placeReviewRetryQuestion({
    retryItem,
    currentItem: reviewItem("current"),
    queue: [],
  });

  assert.deepEqual(result.queue.map((item) => item.questionId), ["failed"]);
  assert.equal(result.deferredRetryItem, null);
});

test("placeReviewRetryQuestion puts retry after the next different queued question", () => {
  const retryItem = reviewItem("failed");
  const result = placeReviewRetryQuestion({
    retryItem,
    currentItem: null,
    queue: [reviewItem("next"), reviewItem("later")],
  });

  assert.deepEqual(result.queue.map((item) => item.questionId), [
    "next",
    "failed",
    "later",
  ]);
  assert.equal(result.deferredRetryItem, null);
});

test("releaseDeferredReviewRetries releases held retries after a different question", () => {
  const result = releaseDeferredReviewRetries({
    currentItem: reviewItem("current"),
    queue: [reviewItem("later")],
    deferredRetryItems: [reviewItem("failed-a"), reviewItem("failed-b")],
  });

  assert.deepEqual(result.queue.map((item) => item.questionId), [
    "failed-a",
    "failed-b",
    "later",
  ]);
  assert.deepEqual(result.deferredRetryItems, []);
});

test("releaseDeferredReviewRetries keeps a held retry when the current item is the same question", () => {
  const retryItem = reviewItem("failed");
  const result = releaseDeferredReviewRetries({
    currentItem: retryItem,
    queue: [],
    deferredRetryItems: [retryItem],
  });

  assert.deepEqual(result.queue, []);
  assert.deepEqual(result.deferredRetryItems, [retryItem]);
});

test("deferredReviewRetryQuestionIds returns stable backend exclusion ids", () => {
  assert.deepEqual(
    deferredReviewRetryQuestionIds([
      reviewItem("failed-a"),
      reviewItem("failed-b"),
    ]),
    ["failed-a", "failed-b"],
  );
});

test("mergeDeferredReviewRetryItem replaces stale copies of the same retry", () => {
  const original = reviewItem("failed", "Old text");
  const updated = reviewItem("failed", "Updated text");

  assert.deepEqual(
    mergeDeferredReviewRetryItem([original], updated),
    [updated],
  );
});
