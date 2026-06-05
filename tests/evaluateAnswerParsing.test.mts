import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEvaluation,
  parseScore,
  PROBING_QUESTION_SCORE_THRESHOLD,
} from "../app/lib/evaluateAnswerParsing.ts";

test("parseScore accepts only finite numeric scores and normalizes to 0-10 integers", () => {
  assert.equal(parseScore(0), 0);
  assert.equal(parseScore(7), 7);
  assert.equal(parseScore(7.6), 8);
  assert.equal(parseScore(-2), 0);
  assert.equal(parseScore(11), 10);
  assert.equal(parseScore(Number.NaN), null);
  assert.equal(parseScore(Number.POSITIVE_INFINITY), null);
  assert.equal(parseScore("7"), null);
  assert.equal(parseScore(null), null);
});

test("parseEvaluation assigns the normalized numeric score returned by the evaluator", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 6.6,
      justification: "Mostly correct.",
      answerSummary: "Correct but incomplete",
      probingQuestions: ["Which missing detail matters?"],
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 7,
    justification: "Mostly correct.",
    answerSummary: "Correct but incomplete",
    probingQuestions: [],
  });
});

test("parseEvaluation fails closed when score is missing or not numeric", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: "8",
      justification: "Looks good.",
      answerSummary: "Good answer",
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "failed",
    score: null,
    justification: "LLM evaluation failed or returned invalid score.",
    answerSummary: "fallback answer",
    probingQuestions: [],
  });
});

test("parseEvaluation fails closed on invalid JSON", () => {
  const result = parseEvaluation("not json", "fallback answer");

  assert.deepEqual(result, {
    status: "failed",
    score: null,
    justification: "LLM evaluation failed or returned invalid JSON.",
    answerSummary: "fallback answer",
    probingQuestions: [],
  });
});

test("parseEvaluation accepts fenced JSON responses", () => {
  const result = parseEvaluation(
    '```json\n{"score":10,"justification":"Complete.","answer_summary":"Precise answer","probing_questions":["ignored"]}\n```',
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 10,
    justification: "Complete.",
    answerSummary: "Precise answer",
    probingQuestions: [],
  });
});

test("parseEvaluation keeps sanitized probing questions only for low scores", () => {
  const longQuestion = `${"x".repeat(221)}?`;
  const result = parseEvaluation(
    JSON.stringify({
      score: PROBING_QUESTION_SCORE_THRESHOLD,
      justification: "Important gaps.",
      conciseAnswer: "Partial answer",
      probingQuestions: [
        "  What step is missing?  ",
        "what step is missing?",
        "",
        42,
        longQuestion,
        "How does the sign change?",
        "Why is the denominator squared?",
        "This fourth valid question should be dropped.",
      ],
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: PROBING_QUESTION_SCORE_THRESHOLD,
    justification: "Important gaps.",
    answerSummary: "Partial answer",
    probingQuestions: [
      "What step is missing?",
      "How does the sign change?",
      "Why is the denominator squared?",
    ],
  });
});

test("parseEvaluation truncates verbose justification and answer summary", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 4,
      justification:
        "one two three four five six seven eight nine ten eleven twelve thirteen",
      answerSummary:
        "one two three four five six seven eight nine ten eleven twelve thirteen",
      probingQuestions: [],
    }),
    "fallback answer",
  );

  assert.equal(result.status, "graded");
  assert.equal(
    result.justification,
    "one two three four five six seven eight nine ten eleven twelve...",
  );
  assert.equal(
    result.answerSummary,
    "one two three four five six seven eight nine ten eleven twelve...",
  );
});

test("parseEvaluation uses a concise fallback summary for blank answers", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 1,
      justification: "Mostly absent.",
      answerSummary: "",
      probingQuestions: [],
    }),
    "   ",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 1,
    justification: "Mostly absent.",
    answerSummary: "(blank)",
    probingQuestions: [],
  });
});
