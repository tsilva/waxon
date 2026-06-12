import assert from "node:assert/strict";
import test from "node:test";
import { ensureCourseChatTurnHasLearnerQuestion } from "../app/lib/courseChatTurn.ts";
import { normalizePartialCourseToc } from "../app/lib/courseTocStream.ts";

test("ensureCourseChatTurnHasLearnerQuestion creates first-milestone content for empty output", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.match(result.text, /Why PPO Needs an Entropy Term/u);
  assert.match(result.text, /Explain why entropy/u);
  assert.match(result.text, /What is the main idea/u);
  assert.equal(result.appendedText, result.text);
});

test("ensureCourseChatTurnHasLearnerQuestion appends checkpoint to lesson without a question", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Entropy regularization rewards a policy for keeping action probabilities spread out.",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.match(result.text, /Entropy regularization rewards/u);
  assert.match(result.text, /Checkpoint/u);
  assert.match(result.text, /What is the main idea/u);
  assert.match(result.appendedText, /Checkpoint/u);
});

test("ensureCourseChatTurnHasLearnerQuestion preserves a complete learner question", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Entropy keeps the policy from collapsing too early.\n\nWhy does that matter for PPO?",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.equal(
    result.text,
    "Entropy keeps the policy from collapsing too early.\n\nWhy does that matter for PPO?",
  );
  assert.equal(result.appendedText, "");
});

test("normalizePartialCourseToc extracts complete streamed TOC pages", () => {
  const partialToc = normalizePartialCourseToc(
    [
      '{"title":"PPO Entropy Loss","description":"Explore entropy in PPO.","pages":[',
      '{"title":"Why PPO Needs Entropy","objective":"Explain entropy as an exploration pressure."},',
      '{"title":"Entropy Coefficient","objective":"Tune the coefficient',
    ].join(""),
  );

  assert.equal(partialToc.title, "PPO Entropy Loss");
  assert.equal(partialToc.description, "Explore entropy in PPO.");
  assert.deepEqual(partialToc.pages, [
    {
      title: "Why PPO Needs Entropy",
      objective: "Explain entropy as an exploration pressure.",
    },
  ]);
});

test("normalizePartialCourseToc handles escaped strings in streamed properties", () => {
  const partialToc = normalizePartialCourseToc(
    '{"title":"PPO \\"entropy\\" loss","description":"A \\\\ B","pages":[]}',
  );

  assert.equal(partialToc.title, 'PPO "entropy" loss');
  assert.equal(partialToc.description, "A \\ B");
});
