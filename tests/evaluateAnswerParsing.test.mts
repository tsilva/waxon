import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSystemPrompt,
} from "../app/lib/evaluateAnswerPrompt.ts";
import {
  parseEvaluation,
  parseScore,
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
    correctAnswer: null,
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
    correctAnswer: null,
  });
});

test("parseEvaluation fails closed on invalid JSON", () => {
  const result = parseEvaluation("not json", "fallback answer");

  assert.deepEqual(result, {
    status: "failed",
    score: null,
    justification: "LLM evaluation failed or returned invalid JSON.",
    answerSummary: "fallback answer",
    correctAnswer: null,
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
    correctAnswer: null,
  });
});

test("parseEvaluation keeps conciseAnswer as the correct answer field", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 2,
      justification: "Important gaps.",
      conciseAnswer: "Partial answer",
      probingQuestions: [
        "  What step is missing?  ",
        "what step is missing?",
      ],
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 2,
    justification: "Important gaps.",
    answerSummary: "fallback answer",
    correctAnswer: "Partial answer",
  });
});

test("parseEvaluation reads correctAnswer without replacing answerSummary", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 8,
      justification: "Good recall.",
      answerSummary: "User gave the core distinction",
      correctAnswer: "A linear threshold classifier.",
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 8,
    justification: "Good recall.",
    answerSummary: "User gave the core distinction",
    correctAnswer: "A linear threshold classifier.",
  });
});

test("parseEvaluation formats formulas in correctAnswer as markdown", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 6,
      justification: "Key idea present.",
      answerSummary: "Compared shifted logit sum.",
      correctAnswer:
        "Since exp(-1)<1, exp(0)+exp(-1)<2; ln is increasing, so ln(sum)<ln(2).",
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 6,
    justification: "Key idea present.",
    answerSummary: "Compared shifted logit sum.",
    correctAnswer:
      "Since $exp(-1)<1$, $exp(0)+exp(-1)<2$; ln is increasing, so $ln(sum)<ln(2)$.",
  });
});

test("parseEvaluation formats compact exponent correct answers as math", () => {
  const result = parseEvaluation(
    JSON.stringify({
      score: 5,
      justification: "Missing exponent notation.",
      answerSummary: "x - 7",
      correctAnswer: "`x^{-7}` (or `1/x^7`)",
    }),
    "fallback answer",
  );

  assert.deepEqual(result, {
    status: "graded",
    score: 5,
    justification: "Missing exponent notation.",
    answerSummary: "x - 7",
    correctAnswer: "$x^{-7}$ (or $1/x^7$)",
  });
});

test("evaluateAnswer prompt prefers explicit matrix product notation", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /inline math for mathematical formulas/u);
  assert.match(prompt, /Q = x @ W_q/u);
  assert.match(prompt, /implicit multiplication/u);
  assert.match(prompt, /Q = XW_Q/u);
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
    correctAnswer: null,
  });
});
