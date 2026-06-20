import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuestionEvaluationSnippet,
  parseQuestionEvaluationSnippet,
} from "../app/lib/courseEvaluationSnippet.ts";

test("parseQuestionEvaluationSnippet extracts metadata and strips internal comments", () => {
  const question =
    "In one sentence, what happens to the probability of a sampled action when its advantage is positive versus negative?";
  const questionId = "2f432fc8-129f-46ba-b8ee-702c528a8050";
  const correctAnswer =
    "If the advantage is positive, the sampled action's probability increases; if the advantage is negative, its probability decreases.";
  const content = [
    "<!-- waxon:evaluation-snippet score=4 -->",
    `<!-- waxon:evaluation-question-id ${encodeURIComponent(questionId)} -->`,
    `<!-- waxon:evaluation-question ${encodeURIComponent(question)} -->`,
    `<!-- waxon:evaluation-correct-answer ${encodeURIComponent(correctAnswer)} -->`,
    "**Score 4/10**",
    "The answer partially captures the positive-advantage case, but misses the negative-advantage case.",
  ].join("\n\n");

  assert.equal(isQuestionEvaluationSnippet(content), true);
  assert.match(content, /action's%20probability/u);

  const parsed = parseQuestionEvaluationSnippet(content);

  assert.deepEqual(parsed, {
    content:
      "The answer partially captures the positive-advantage case, but misses the negative-advantage case.",
    questionId,
    question,
    correctAnswer,
    score: 4,
  });
  assert.doesNotMatch(parsed?.content ?? "", /waxon:evaluation/u);
  assert.doesNotMatch(parsed?.content ?? "", /Score 4\/10/u);
});

test("parseQuestionEvaluationSnippet reads metadata regardless of comment order", () => {
  const content = [
    "<!-- waxon:evaluation-snippet score=8 -->",
    `<!-- waxon:evaluation-correct-answer ${encodeURIComponent("Expected answer.")} -->`,
    `<!-- waxon:evaluation-question ${encodeURIComponent("What is expected?")} -->`,
    "Good answer.",
  ].join("\n\n");

  const parsed = parseQuestionEvaluationSnippet(content);

  assert.equal(parsed?.question, "What is expected?");
  assert.equal(parsed?.questionId, null);
  assert.equal(parsed?.correctAnswer, "Expected answer.");
  assert.equal(parsed?.content, "Good answer.");
});

test("parseQuestionEvaluationSnippet strips metadata comments from the visible body", () => {
  const content = [
    "<!-- waxon:evaluation-snippet score=3 -->",
    "Needs more detail.",
    `<!-- waxon:evaluation-correct-answer ${encodeURIComponent("Expected answer.")} -->`,
  ].join("\n\n");

  const parsed = parseQuestionEvaluationSnippet(content);

  assert.equal(parsed?.content, "Needs more detail.");
  assert.equal(parsed?.correctAnswer, "Expected answer.");
});

test("parseQuestionEvaluationSnippet infers high-score correct answers from feedback without metadata", () => {
  const content = [
    "<!-- waxon:evaluation-snippet score=10 -->",
    `<!-- waxon:evaluation-question ${encodeURIComponent("What happens when advantage is negative?")} -->`,
    "**Score 10/10**",
    "Correct. A negative advantage pushes the sampled action's probability downward.",
  ].join("\n\n");

  const parsed = parseQuestionEvaluationSnippet(content);

  assert.equal(
    parsed?.correctAnswer,
    "A negative advantage pushes the sampled action's probability downward.",
  );
});
