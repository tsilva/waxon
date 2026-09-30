import assert from "node:assert/strict";
import test from "node:test";
import { advanceReviewWindow } from "../app/lib/v2/reviewWindow.ts";
import type { V2ReviewQueueResponse } from "../app/lib/v2/types.ts";

const now = new Date("2030-09-30T10:00:00Z");
function queue(total: number): V2ReviewQueueResponse {
  const question = (id: number) => ({ questionId: String(id), prompt: `Prompt ${id}`, relatedTags: [], total, scheduledFor: null });
  return { question: question(0), upcomingQuestions: Array.from({ length: Math.min(8, total - 1) }, (_, i) => question(i + 1)),
    recentAnswers: [], isLibraryEmpty: false, waitingOnEvaluation: false,
    timezone: "Europe/Lisbon", localDay: "2030-09-30", summary: { queueRemaining: total, nextScheduledOn: null } };
}

test("a partial Review window cannot silently wrap or shrink complete membership", () => {
  let current = queue(500);
  for (let id = 1; id <= 8; id++) {
    const next = advanceReviewWindow(current, { now });
    assert.ok(next); assert.equal(next.question?.questionId, String(id));
    assert.equal(next.summary.queueRemaining, 500); current = next;
  }
  assert.equal(advanceReviewWindow(current, { now }), null);
});

test("a complete small queue rotates locally without excluding unanswered Questions", () => {
  let current = queue(3);
  for (let id = 1; id <= 9; id++) {
    const next = advanceReviewWindow(current, { now });
    assert.ok(next); assert.equal(next.question?.questionId, String(id % 3)); current = next;
  }
});

test("accepted answers remove the submitted candidate and retain pending feedback", () => {
  const current = queue(3);
  const evaluation = { submissionId: "accepted", evaluationId: "evaluation", status: "pending" as const,
    recallResult: null, nextDueOn: null, feedback: null, expectedAnswer: null,
    coveredPoints: [], scoringIssues: [], confidence: null, canRetryEvaluation: false, canCorrectRecallResult: false };
  const next = advanceReviewWindow(current, { now, removeCurrent: true, evaluation, answer: "Saved answer" });
  assert.ok(next); assert.equal(next.summary.queueRemaining, 2);
  assert.deepEqual(next.upcomingQuestions?.map((question) => question.questionId), ["2"]);
  assert.equal(next.recentAnswers[0].evaluation, evaluation);
  assert.equal(next.waitingOnEvaluation, true);
  assert.equal(advanceReviewWindow(queue(3), { now: new Date("2030-10-01T12:00:00Z") }), null);
});
