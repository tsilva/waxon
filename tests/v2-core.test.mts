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
