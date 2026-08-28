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
      grade: "hard",
      nextDueOn: "2026-08-30",
      feedback: "You recovered the main trade-off.",
      expectedAnswer: "More environments can shorten each trajectory.",
      coveredPoints: ["Memory and CPU overhead"],
      missingPoints: ["Short trajectories can\nbias GAE"],
      demonstratedGap: "The GAE effect was missing.",
      confidence: 0.9,
      canSelfGrade: false,
      canCorrectGrade: true,
      ...overrides,
    },
  };
}

test("builds a complete Markdown handoff from an expanded review", () => {
  assert.equal(
    reviewHandoffMarkdown(reviewAnswer()),
    `# Waxon review

## Question

Why does **vectorization** have trade-offs?

## Your answer

Too many environments add overhead.

## Answer standard

More environments can shorten each trajectory.

## Evaluation feedback

You recovered the main trade-off.

## Demonstrated gap

The GAE effect was missing.

## Recovered

- Memory and CPU overhead

## Missing

- Short trajectories can
  bias GAE

## Review metadata

- Status: Complete
- Grade: Hard (2)
- Submitted: 2026-08-28T09:17:00.000Z
- Next review: 2026-08-30`,
  );
});

test("represents incomplete evaluation content without leaking null values", () => {
  const markdown = reviewHandoffMarkdown(
    reviewAnswer({
      status: "pending",
      grade: null,
      nextDueOn: null,
      feedback: null,
      expectedAnswer: null,
      coveredPoints: [],
      missingPoints: [],
      demonstratedGap: null,
    }),
  );

  assert.match(markdown, /## Answer standard\n\nUnavailable/u);
  assert.match(markdown, /## Recovered\n\n- None/u);
  assert.match(markdown, /- Status: Evaluating/u);
  assert.match(markdown, /- Grade: Unavailable/u);
  assert.equal(markdown.includes("null"), false);
  assert.equal(markdown.includes("undefined"), false);
});
