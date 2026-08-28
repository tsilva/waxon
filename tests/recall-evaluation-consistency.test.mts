import assert from "node:assert/strict";
import test from "node:test";
import {
  RECALL_EVALUATION_SYSTEM_PROMPT,
  deriveAnswerGrades,
  evaluateRecallWithRetries,
  legacyGradeToRecallResult,
  reconcileRecallEvaluation,
  type RecallEvaluationResult,
} from "../app/lib/v2/recallEvaluation.ts";

function evaluation(
  overrides: Partial<RecallEvaluationResult>,
): RecallEvaluationResult {
  return {
    recallResult: "correct",
    coveredPoints: ["Required knowledge"],
    scoringIssues: [],
    clarifications: [],
    confidence: 0.95,
    ...overrides,
  };
}

test("the policy separates Recall Result from scheduling grades", () => {
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /incorrect, partial, or correct/u);
  assert.doesNotMatch(RECALL_EVALUATION_SYSTEM_PROMPT, /again\|hard\|good\|easy/u);
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /Clarifications must never lower/u);
});

test("derives the approved Answer Grade sequences", () => {
  assert.deepEqual(deriveAnswerGrades(["correct"]), ["good"]);
  assert.deepEqual(deriveAnswerGrades(["correct", "correct"]), ["good", "good"]);
  assert.deepEqual(
    deriveAnswerGrades(["correct", "correct", "correct", "correct"]),
    ["good", "good", "easy", "easy"],
  );
  assert.deepEqual(
    deriveAnswerGrades(["partial", "correct", "correct", "correct"]),
    ["again", "hard", "good", "easy"],
  );
  assert.deepEqual(
    deriveAnswerGrades(["incorrect", "correct", "partial"]),
    ["again", "hard", "again"],
  );
});

test("maps legacy grades conservatively to Recall Results", () => {
  assert.equal(legacyGradeToRecallResult("again"), "incorrect");
  assert.equal(legacyGradeToRecallResult("hard"), "partial");
  assert.equal(legacyGradeToRecallResult("good"), "correct");
  assert.equal(legacyGradeToRecallResult("easy"), "correct");
});

test("moves a non-required presentation difference into clarifications", () => {
  const result = reconcileRecallEvaluation({
    prompt: "What is the clipped PPO surrogate objective for one transition?",
    result: evaluation({
      recallResult: "partial",
      coveredPoints: ["Probability ratio", "Clipping operation"],
      scoringIssues: ["Mathematical notation"],
    }),
  });

  assert.equal(result.recallResult, "correct");
  assert.deepEqual(result.scoringIssues, []);
  assert.deepEqual(result.clarifications, ["Mathematical notation"]);
  assert.match(result.feedback, /For precision only/u);
  assert.match(result.feedback, /does not affect your Recall Result/u);
});

test("keeps explicitly requested notation as a scoring issue", () => {
  const result = reconcileRecallEvaluation({
    prompt: "Write the clipped PPO objective in mathematical notation.",
    result: evaluation({
      recallResult: "partial",
      scoringIssues: ["Mathematical notation"],
    }),
  });

  assert.equal(result.recallResult, "partial");
  assert.deepEqual(result.scoringIssues, ["Mathematical notation"]);
});

test("downgrades a false Correct when scoring issues remain", () => {
  const partial = reconcileRecallEvaluation({
    prompt: "What is the clipped PPO objective?",
    result: evaluation({
      recallResult: "correct",
      scoringIssues: ["The minimum of the clipped and unclipped objectives is missing"],
    }),
  });
  assert.equal(partial.recallResult, "partial");

  const incorrect = reconcileRecallEvaluation({
    prompt: "What is the clipped PPO objective?",
    result: evaluation({
      recallResult: "correct",
      coveredPoints: [],
      scoringIssues: ["The objective was not described"],
    }),
  });
  assert.equal(incorrect.recallResult, "incorrect");
});

test("rejects a failed result without a scoring issue", () => {
  assert.throws(
    () =>
      reconcileRecallEvaluation({
        prompt: "What is PPO?",
        result: evaluation({
          recallResult: "partial",
          scoringIssues: [],
        }),
      }),
    /without a scoring issue/u,
  );
});

test("retries inconsistent and low-confidence evaluations automatically", async () => {
  let calls = 0;
  const result = await evaluateRecallWithRetries({
    prompt: "What is PPO?",
    evaluate: async () => {
      calls += 1;
      if (calls === 1) {
        return evaluation({
          recallResult: "partial",
          scoringIssues: [],
        });
      }
      if (calls === 2) {
        return evaluation({ confidence: 0.2 });
      }
      return evaluation({ confidence: 0.95 });
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.recallResult, "correct");
});
