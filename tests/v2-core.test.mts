import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToken, hashMcpToken } from "../app/lib/v2/mcpToken.ts";
import {
  normalizeQuestionInput,
  normalizeQuestionPrompt,
  questionPromptKey,
} from "../app/lib/v2/questionInput.ts";
import { assessQuestionQuality } from "../app/lib/v2/questionQuality.ts";
import {
  normalizeReviewFlagInput,
  REVIEW_FLAG_REASONS,
} from "../app/lib/v2/reviewFlag.ts";
import { applyFsrsGrade } from "../app/lib/v2/scheduler.ts";
import { v2Error } from "../app/lib/v2/http.ts";

const now = new Date("2026-07-25T10:00:00.000Z");


test("Question input is normalized and receives strong defaults", () => {
  const input = normalizeQuestionInput({
    prompt: "  What   does   FSRS schedule? ",
    referenceAnswer: "It schedules the next review from memory state.",
  });
  assert.equal(input.prompt, "What does FSRS schedule?");
  assert.equal("answerMode" in input, false);
  assert.equal("importance" in input, false);
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

test("default quality assessment rejects known defects and accepts clear recall", () => {
  assert.deepEqual(
    assessQuestionQuality({
      prompt: "Explain everything about transformers?",
      referenceAnswer: "A very broad answer.",
      target: "Transformers",
    }),
    { outcome: "fail", reasons: ["not_atomic"] },
  );
  assert.deepEqual(
    assessQuestionQuality({
      prompt: "What color is it?",
      referenceAnswer: "Blue.",
      target: "What color is it?",
    }),
    { outcome: "fail", reasons: ["not_self_contained"] },
  );
  assert.deepEqual(
    assessQuestionQuality({
      prompt: "What is the capital of Portugal?",
      referenceAnswer: "I don't know.",
      target: "What is the capital of Portugal?",
    }),
    { outcome: "fail", reasons: ["not_answerable"] },
  );
  assert.deepEqual(
    assessQuestionQuality({
      prompt: "Why are attention logits divided by the square root of key dimension?",
      referenceAnswer:
        "It controls their variance so softmax does not saturate as key dimension grows.",
      target: "Purpose of scaled dot-product attention",
    }),
    { outcome: "pass", reasons: [] },
  );
  for (const candidate of [
    {
      prompt: "Who founded the company?",
      referenceAnswer: "Alice.",
    },
    {
      prompt: "What is it and why?",
      referenceAnswer: "Because.",
    },
    {
      prompt: "What is a worker process?",
      referenceAnswer: "A process.",
    },
  ]) {
    assert.notEqual(
      assessQuestionQuality({ ...candidate, target: candidate.prompt }).outcome,
      "pass",
    );
  }
  for (const candidate of [
    {
      prompt: "What protection is provided by TLS?",
      referenceAnswer:
        "TLS provides confidentiality, integrity, and peer authentication for data in transit.",
    },
    {
      prompt: "Which muscles are attached to the scapula?",
      referenceAnswer:
        "Seventeen muscles attach to the scapula, including the rotator cuff and trapezius muscles.",
    },
    {
      prompt: "Why does it rain?",
      referenceAnswer:
        "Water vapor condenses into droplets that become heavy enough to fall from clouds.",
    },
    {
      prompt: "What does it mean for a function to be continuous?",
      referenceAnswer:
        "Small changes in the input produce arbitrarily small changes in the output around each point.",
    },
    {
      prompt: "Which protocol is connection-oriented, TCP or UDP?",
      referenceAnswer: "TCP.",
    },
  ]) {
    assert.deepEqual(
      assessQuestionQuality({ ...candidate, target: candidate.prompt }),
      { outcome: "pass", reasons: [] },
    );
  }
});

test("Answer Grades alone produce progressive and adaptive intervals", () => {
  const hard = applyFsrsGrade({ memory: null, grade: "hard", now });
  const first = applyFsrsGrade({
    memory: null,
    grade: "good",
    now,
  });
  const easy = applyFsrsGrade({ memory: null, grade: "easy", now });
  const second = applyFsrsGrade({
    memory: first,
    grade: "good",
    now: first.dueAt,
  });
  const failed = applyFsrsGrade({
    memory: second,
    grade: "again",
    now: second.dueAt,
  });

  assert.equal(hard.scheduledDays < first.scheduledDays, true);
  assert.equal(first.scheduledDays < easy.scheduledDays, true);
  assert.equal(second.scheduledDays > first.scheduledDays, true);
  assert.equal(failed.scheduledDays < second.scheduledDays, true);
  assert.equal(failed.lapses > second.lapses, true);
});

test("MCP tokens are high-entropy and hash deterministically", () => {
  const first = createMcpToken();
  const second = createMcpToken();
  assert.match(first, /^waxon_mcp_[A-Za-z0-9_-]{40,}$/u);
  assert.notEqual(first, second);
  assert.equal(hashMcpToken(first), hashMcpToken(first));
  assert.notEqual(hashMcpToken(first), hashMcpToken(second));
});

test("Review Flag input accepts empty data and normalizes known multi-select reasons", () => {
  assert.equal(REVIEW_FLAG_REASONS.length >= 4, true);
  assert.deepEqual(REVIEW_FLAG_REASONS[0], {
    id: "prompt_unclear",
    label: "Question is unclear",
  });
  assert.deepEqual(normalizeReviewFlagInput({ reasons: [], detail: "  " }), {
    reasons: [],
    detail: null,
  });
  assert.deepEqual(
    normalizeReviewFlagInput({
      reasons: [
        "prompt_unclear",
        "answer_standard_incorrect",
        "prompt_unclear",
      ],
      detail: "  The explanation contradicts the prompt.  ",
    }),
    {
      reasons: ["prompt_unclear", "answer_standard_incorrect"],
      detail: "The explanation contradicts the prompt.",
    },
  );
  assert.throws(
    () => normalizeReviewFlagInput({ reasons: ["unknown_reason"] }),
    /recognized Flag Reason/u,
  );
});

test("a stale Library Flag lifecycle is an HTTP conflict", async () => {
  const response = v2Error(new Error("This Question is no longer Active."));

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "This Question is no longer Active.",
  });
});
