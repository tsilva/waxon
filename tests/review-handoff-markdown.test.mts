import assert from "node:assert/strict";
import test from "node:test";
import { reviewHandoffMarkdown } from "../app/lib/reviewHandoffMarkdown.ts";
import type { V2ReviewAnswer } from "../app/lib/v2/types.ts";

function reviewAnswer(
  overrides: Partial<V2ReviewAnswer["evaluation"]> = {},
): V2ReviewAnswer {
  return {
    prompt: "Why does **vectorization** have trade-offs?",
    answer: "Too many environments add overhead.",
    submittedAt: "2026-08-28T09:17:00.000Z",
    evaluation: {
      submissionId: "submission-1",
      evaluationId: "evaluation-1",
      status: "complete",
      recallResult: "partial",
      nextDueOn: "2026-08-28",
      feedback: "Partial. You recovered part of the Recall Target.",
      expectedAnswer: "More environments can shorten each trajectory.",
      coveredPoints: ["Memory and CPU overhead"],
      scoringIssues: ["Short trajectories can\nbias GAE"],
      clarifications: ["Vectorization can still improve throughput"],
      confidence: 0.9,
      canRetryEvaluation: false,
      canCorrectRecallResult: true,
      ...overrides,
    },
  };
}

test("builds a Recall Result handoff without exposing Answer Grades", () => {
  const markdown = reviewHandoffMarkdown(reviewAnswer());
  assert.match(markdown, /## Scoring issues\n\n- Short trajectories can\n  bias GAE/u);
  assert.match(markdown, /## Clarifications/u);
  assert.match(markdown, /- Recall Result: Partial/u);
  assert.doesNotMatch(markdown, /\b(?:Again|Hard|Good|Easy) \([0-4]\)/u);
  assert.doesNotMatch(markdown, /- Grade:/u);
});

test("represents incomplete evaluation content without leaking null values", () => {
  const markdown = reviewHandoffMarkdown(
    reviewAnswer({
      status: "pending",
      recallResult: null,
      nextDueOn: null,
      feedback: null,
      expectedAnswer: null,
      coveredPoints: [],
      scoringIssues: [],
      clarifications: [],
      canCorrectRecallResult: false,
    }),
  );

  assert.match(markdown, /## Answer standard\n\nUnavailable/u);
  assert.match(markdown, /## Recovered\n\n- None/u);
  assert.match(markdown, /- Status: Evaluating/u);
  assert.match(markdown, /- Recall Result: Unavailable/u);
  assert.equal(markdown.includes("null"), false);
  assert.equal(markdown.includes("undefined"), false);
});
