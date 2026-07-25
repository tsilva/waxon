import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPlan, type PlanCandidate } from "../app/lib/v2/planner.ts";
import {
  assessQuestionQuality,
  normalizeExactAnswer,
  recallTargetKey,
} from "../app/lib/v2/questionQuality.ts";
import {
  applyFsrsGrade,
  memoryRetrievability,
} from "../app/lib/v2/scheduler.ts";
import {
  MINIMUM_SOLO_RETRY_DELAY_MS,
  retryEarliestAt,
} from "../app/lib/v2/retryPolicy.ts";

const now = new Date("2026-07-25T10:00:00.000Z");

function candidate(
  overrides: Partial<PlanCandidate> & Pick<PlanCandidate, "questionId">,
): PlanCandidate {
  return {
    questionVersionId: `${overrides.questionId}-version`,
    lifecycle: "review",
    answerMode: "semantic",
    dueAt: new Date(now.getTime() - 86_400_000),
    retrievability: 0.6,
    importance: 1,
    hasGap: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("v2 quality gates reject broad and non-retrieval prompts", () => {
  const broad = assessQuestionQuality({
    prompt: "Explain everything about transformers?",
    referenceAnswer: "A very broad answer.",
    target: "Transformers",
  });
  const atomic = assessQuestionQuality({
    prompt: "Why are attention logits divided by the square root of key dimension?",
    referenceAnswer:
      "It keeps their variance controlled so softmax does not saturate as key dimension grows.",
    target: "Purpose of scaled dot-product attention",
  });

  assert.equal(broad.passes, false);
  assert.match(broad.reasons.join(" "), /atomic/iu);
  assert.equal(atomic.passes, true);
});

test("v2 target and exact-answer normalization are stable", () => {
  assert.equal(
    recallTargetKey("Scaled dot-product attention."),
    recallTargetKey("  SCALED dot product_attention! "),
  );
  assert.equal(normalizeExactAnswer("  AdamW\n"), normalizeExactAnswer("adamw"));
});

test("v2 planner prioritizes fragile important memories and reserves retry time", () => {
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 4,
    desiredRetention: 0.9,
    newItemsPerDay: 5,
    candidates: [
      candidate({
        questionId: "healthy",
        retrievability: 0.88,
        importance: 1,
      }),
      candidate({
        questionId: "fragile",
        retrievability: 0.3,
        importance: 2,
      }),
      candidate({
        questionId: "new",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
    ],
  });

  assert.deepEqual(
    plan.map((item) => item.questionId),
    ["fragile", "healthy"],
  );
  assert.equal(
    plan.reduce((sum, item) => sum + item.estimatedSeconds * 2, 0) <= 240,
    true,
  );
});

test("v2 planner caps new admissions independently of bank size", () => {
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 30,
    desiredRetention: 0.9,
    newItemsPerDay: 2,
    candidates: Array.from({ length: 20 }, (_, index) =>
      candidate({
        questionId: `new-${index}`,
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
    ),
  });

  assert.equal(plan.length, 2);
});

test("v2 planner protects every at-risk item when it fits", () => {
  const due = [
    candidate({ questionId: "a", answerMode: "exact" }),
    candidate({ questionId: "b", answerMode: "semantic" }),
    candidate({ questionId: "c", answerMode: "rubric" }),
  ];
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 10,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates: due,
  });

  assert.deepEqual(
    new Set(plan.map((item) => item.questionId)),
    new Set(due.map((item) => item.questionId)),
  );
});

test("adding planner capacity cannot remove protected due work", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    candidate({
      questionId: `due-${index}`,
      answerMode: index % 3 === 0 ? "rubric" : "semantic",
      retrievability: 0.2 + index * 0.03,
    }),
  );
  const smaller = buildReviewPlan({
    now,
    timeBudgetMinutes: 5,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates,
  });
  const larger = buildReviewPlan({
    now,
    timeBudgetMinutes: 10,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates,
  });
  const largerIds = new Set(larger.map((item) => item.questionId));

  assert.equal(
    smaller.every((item) => largerIds.has(item.questionId)),
    true,
  );
});

test("exact mode normalizes Japanese width and case without translating", () => {
  assert.equal(normalizeExactAnswer(" ＡＤＡＭＷ "), "adamw");
  assert.equal(normalizeExactAnswer("勾配 降下"), "勾配 降下");
});

test("v2 retry policy is delayed unless a different question intervenes", () => {
  assert.equal(
    retryEarliestAt({
      hasDifferentQuestionAfter: false,
      now,
    }).getTime(),
    now.getTime() + MINIMUM_SOLO_RETRY_DELAY_MS,
  );
  assert.equal(
    retryEarliestAt({
      hasDifferentQuestionAfter: true,
      now,
    }).getTime(),
    now.getTime(),
  );
});

test("v2 FSRS lengthens successful recall and makes failure conservative", () => {
  const first = applyFsrsGrade({
    memory: null,
    grade: "good",
    desiredRetention: 0.9,
    now,
  });
  const secondAt = new Date(first.dueAt.getTime() + 1_000);
  const second = applyFsrsGrade({
    memory: first,
    grade: "good",
    desiredRetention: 0.9,
    now: secondAt,
  });
  const failed = applyFsrsGrade({
    memory: second,
    grade: "again",
    desiredRetention: 0.9,
    now: new Date(second.dueAt.getTime() + 1_000),
  });

  assert.equal(second.scheduledDays >= first.scheduledDays, true);
  assert.equal(failed.lapses > second.lapses, true);
  assert.equal(
    memoryRetrievability({
      memory: failed,
      desiredRetention: 0.9,
      at: failed.dueAt,
    }) <= 1,
    true,
  );
});
