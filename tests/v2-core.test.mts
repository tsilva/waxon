import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToken, hashMcpToken } from "../app/lib/v2/mcpToken.ts";
import { buildReviewPlan, type PlanCandidate } from "../app/lib/v2/planner.ts";
import {
  normalizeQuestionInput,
  normalizeQuestionPrompt,
  questionPromptKey,
} from "../app/lib/v2/questionInput.ts";
import { assessQuestionQuality } from "../app/lib/v2/questionQuality.ts";
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
    dueAt: new Date(now.getTime() - 86_400_000),
    retrievability: 0.6,
    importance: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("lean question input is normalized and receives strong defaults", () => {
  const input = normalizeQuestionInput({
    prompt: "  What   does   FSRS schedule? ",
    referenceAnswer: "It schedules the next review from memory state.",
  });
  assert.equal(input.prompt, "What does FSRS schedule?");
  assert.equal("answerMode" in input, false);
  assert.equal(input.importance, 1);
  assert.equal(input.promptKey, questionPromptKey(input.prompt));
});

test("prompt normalization supports exact duplicate detection", () => {
  assert.equal(
    normalizeQuestionPrompt("  WHAT\n does  FSRS schedule? "),
    normalizeQuestionPrompt("what does fsrs schedule?"),
  );
  assert.equal(
    questionPromptKey("  WHAT\n does  FSRS schedule? "),
    questionPromptKey("what does fsrs schedule?"),
  );
});

test("quality gates reject broad prompts and allow atomic recall", () => {
  assert.equal(
    assessQuestionQuality({
      prompt: "Explain everything about transformers?",
      referenceAnswer: "A very broad answer.",
      target: "Transformers",
    }).passes,
    false,
  );
  assert.equal(
    assessQuestionQuality({
      prompt: "Why are attention logits divided by the square root of key dimension?",
      referenceAnswer:
        "It controls their variance so softmax does not saturate as key dimension grows.",
      target: "Purpose of scaled dot-product attention",
    }).passes,
    true,
  );
});

test("planner puts due work before new work and orders due items by risk", () => {
  const plan = buildReviewPlan({
    now,
    desiredRetention: 0.9,
    scheduledBefore: new Date(now.getTime() + 24 * 60 * 60_000),
    candidates: [
      candidate({ questionId: "healthy", retrievability: 0.88 }),
      candidate({ questionId: "fragile", retrievability: 0.3, importance: 2 }),
      candidate({
        questionId: "new",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
        importance: 5,
      }),
    ],
  });
  assert.deepEqual(
    plan.map((item) => item.questionId),
    ["fragile", "healthy", "new"],
  );
});

test("planner leaves flagged questions out of Review", () => {
  const plan = buildReviewPlan({
    now,
    desiredRetention: 0.9,
    scheduledBefore: new Date(now.getTime() + 24 * 60 * 60_000),
    candidates: [
      candidate({ questionId: "due" }),
      candidate({ questionId: "flagged", lifecycle: "flagged" }),
    ],
  });

  assert.deepEqual(plan.map((item) => item.questionId), ["due"]);
});

test("planner admits every due and unanswered question scheduled for the local day", () => {
  const scheduledBefore = new Date(now.getTime() + 6 * 60 * 60_000);
  const plan = buildReviewPlan({
    now,
    scheduledBefore,
    desiredRetention: 0.9,
    candidates: [
      candidate({ questionId: "due-1" }),
      candidate({ questionId: "due-2" }),
      candidate({
        questionId: "later-today",
        dueAt: new Date(scheduledBefore.getTime() - 1),
      }),
      candidate({
        questionId: "tomorrow",
        dueAt: scheduledBefore,
      }),
      candidate({
        questionId: "new-1",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
      candidate({
        questionId: "new-2",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
      candidate({
        questionId: "interrupted-first-exposure",
        lifecycle: "learning",
        dueAt: null,
        retrievability: null,
      }),
    ],
  });

  assert.deepEqual(
    plan.map((item) => item.questionId),
    [
      "due-1",
      "due-2",
      "later-today",
      "interrupted-first-exposure",
      "new-1",
      "new-2",
    ],
  );
});

test("planner admits every unanswered question", () => {
  const plan = buildReviewPlan({
    now,
    desiredRetention: 0.9,
    scheduledBefore: new Date(now.getTime() + 24 * 60 * 60_000),
    candidates: Array.from({ length: 80 }, (_, index) =>
      candidate({
        questionId: `new-${index}`,
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
    ),
  });
  assert.equal(plan.length, 80);
});

test("planner preserves every scheduled due question", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    candidate({
      questionId: `due-${index}`,
      retrievability: 0.2 + index * 0.03,
    }),
  );
  const plan = buildReviewPlan({
    now,
    desiredRetention: 0.9,
    scheduledBefore: new Date(now.getTime() + 24 * 60 * 60_000),
    candidates,
  });
  assert.equal(plan.length, candidates.length);
  assert.equal(plan.every((item) => item.estimatedSeconds === 60), true);
});

test("one retry is delayed unless another question intervenes", () => {
  assert.equal(
    retryEarliestAt({ hasDifferentQuestionAfter: false, now }).getTime(),
    now.getTime() + MINIMUM_SOLO_RETRY_DELAY_MS,
  );
  assert.equal(
    retryEarliestAt({ hasDifferentQuestionAfter: true, now }).getTime(),
    now.getTime(),
  );
});

test("FSRS grows successful intervals and contracts after failure", () => {
  const first = applyFsrsGrade({
    memory: null,
    grade: "good",
    desiredRetention: 0.9,
    now,
  });
  const second = applyFsrsGrade({
    memory: first,
    grade: "good",
    desiredRetention: 0.9,
    now: new Date(first.dueAt.getTime() + 1_000),
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

test("MCP tokens are high-entropy and hash deterministically", () => {
  const first = createMcpToken();
  const second = createMcpToken();
  assert.match(first, /^waxon_mcp_[A-Za-z0-9_-]{40,}$/u);
  assert.notEqual(first, second);
  assert.equal(hashMcpToken(first), hashMcpToken(first));
  assert.notEqual(hashMcpToken(first), hashMcpToken(second));
});
