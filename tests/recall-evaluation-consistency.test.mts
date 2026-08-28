import assert from "node:assert/strict";
import test from "node:test";
import {
  RECALL_EVALUATION_SYSTEM_PROMPT,
  reconcileRecallEvaluation,
  type RecallEvaluationResult,
} from "../app/lib/v2/recallEvaluation.ts";

function evaluation(
  overrides: Partial<RecallEvaluationResult>,
): RecallEvaluationResult {
  return {
    grade: "good",
    feedback: "The Learner Answer recovered the Recall Target.",
    expectedAnswer: "The stored Answer Standard.",
    coveredPoints: ["Required knowledge"],
    missingPoints: [],
    demonstratedGap: null,
    confidence: 0.95,
    ...overrides,
  };
}

test("the evaluation policy accepts equivalent code, math, pseudocode, and prose", () => {
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /executable code/u);
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /pseudocode/u);
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /mathematical notation/u);
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /prose/u);
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /Prompt explicitly requires that representation/u,
  );
});

test("a formula Answer Standard accepts an equivalent PyTorch Learner Answer", () => {
  const result = reconcileRecallEvaluation({
    prompt: "What is the clipped PPO surrogate objective for one transition?",
    result: evaluation({
      coveredPoints: [
        "Probability ratio",
        "Advantage term",
        "Clipping operation",
        "Minimum operation",
      ],
      missingPoints: [
        "Mathematical notation (provided code implementation instead)",
      ],
      demonstratedGap: "No gap was demonstrated by this successful recall.",
    }),
  });

  assert.deepEqual(result.missingPoints, []);
  assert.equal(result.demonstratedGap, null);
  assert.equal(result.grade, "good");
});

test("a code Answer Standard accepts an equivalent formula Learner Answer", () => {
  const result = reconcileRecallEvaluation({
    prompt: "How do you calculate binary cross-entropy?",
    result: evaluation({
      grade: "hard",
      coveredPoints: ["Negative log-likelihood for both binary outcomes"],
      missingPoints: ["Executable code implementation"],
      demonstratedGap: "The answer used a formula instead of code.",
    }),
  });

  assert.deepEqual(result.missingPoints, []);
  assert.equal(result.demonstratedGap, null);
  assert.equal(result.grade, "good");
});

test("a formula Answer Standard accepts an equivalent prose Learner Answer", () => {
  const result = reconcileRecallEvaluation({
    prompt: "What does Bayes' theorem state?",
    result: evaluation({
      coveredPoints: [
        "Posterior is proportional to likelihood times prior",
        "Evidence is the normalizing denominator",
      ],
      missingPoints: ["Symbolic notation"],
      presentationDifferences: ["The Learner used prose instead of a formula"],
    }),
  });

  assert.deepEqual(result.missingPoints, []);
  assert.equal(result.demonstratedGap, null);
});

test("an explicit mathematical-notation request keeps notation as Missing", () => {
  const result = reconcileRecallEvaluation({
    prompt: "Write the clipped PPO objective in mathematical notation.",
    result: evaluation({
      grade: "hard",
      missingPoints: ["Mathematical notation"],
      demonstratedGap: "No gap was demonstrated.",
    }),
  });

  assert.deepEqual(result.missingPoints, ["Mathematical notation"]);
  assert.equal(
    result.demonstratedGap,
    "The Learner Answer did not demonstrate: Mathematical notation.",
  );
  assert.equal(result.grade, "hard");
});

test("a notation-for Prompt also makes notation part of the Recall Target", () => {
  const result = reconcileRecallEvaluation({
    prompt: "What is the mathematical notation for conditional probability?",
    result: evaluation({
      missingPoints: ["Mathematical notation"],
    }),
  });

  assert.deepEqual(result.missingPoints, ["Mathematical notation"]);
});

test("a substantive point that mentions pseudocode remains Missing", () => {
  const result = reconcileRecallEvaluation({
    prompt: "How does binary search terminate?",
    result: evaluation({
      missingPoints: ["Pseudocode loop termination condition"],
    }),
  });

  assert.deepEqual(result.missingPoints, [
    "Pseudocode loop termination condition",
  ]);
});

test("a substantive Missing point always produces a Demonstrated Gap", () => {
  const result = reconcileRecallEvaluation({
    prompt: "What is the clipped PPO surrogate objective?",
    result: evaluation({
      missingPoints: ["Minimum of the clipped and unclipped objectives"],
      demonstratedGap: null,
    }),
  });

  assert.equal(
    result.demonstratedGap,
    "The Learner Answer did not demonstrate: Minimum of the clipped and unclipped objectives.",
  );
});
