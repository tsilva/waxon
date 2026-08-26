import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToken, hashMcpToken } from "../app/lib/v2/mcpToken.ts";
import {
  normalizeQuestionInput,
  normalizeQuestionPrompt,
  questionPromptKey,
} from "../app/lib/v2/questionInput.ts";
import { assessQuestionQuality } from "../app/lib/v2/questionQuality.ts";
import { applyFsrsGrade } from "../app/lib/v2/scheduler.ts";

const now = new Date("2026-07-25T10:00:00.000Z");


test("lean question input is normalized and receives strong defaults", () => {
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

test("FSRS grows successful intervals and contracts after failure", () => {
  const first = applyFsrsGrade({
    memory: null,
    grade: "good",
    now,
  });
  const second = applyFsrsGrade({
    memory: first,
    grade: "good",
    now: new Date(first.dueAt.getTime() + 1_000),
  });
  const failed = applyFsrsGrade({
    memory: second,
    grade: "again",
    now: new Date(second.dueAt.getTime() + 1_000),
  });
  assert.equal(second.scheduledDays >= first.scheduledDays, true);
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
