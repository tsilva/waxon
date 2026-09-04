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
import {
  parseRecallEvaluationResponse,
  RECALL_EVALUATION_JSON_SCHEMA,
} from "../app/lib/v2/model.ts";

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
  assert.match(RECALL_EVALUATION_SYSTEM_PROMPT, /Confidence is diagnostic only/u);
});

test("the policy requires complete Prompt-scoped coverage for Correct", () => {
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /infer the Recall Target from what the Prompt actually asks/u,
  );
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /Require every distinct answer-bearing claim/u,
  );
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /Do not require supporting content unless the Prompt explicitly asks for it/u,
  );
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /every independent contrast, cause, mechanism, consequence, or condition/u,
  );
  assert.match(
    RECALL_EVALUATION_SYSTEM_PROMPT,
    /each numbered or bulleted Answer Standard item/u,
  );
});

test("declares a strict bounded evaluator response schema", () => {
  assert.equal(RECALL_EVALUATION_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(RECALL_EVALUATION_JSON_SCHEMA.required, [
    "recallResult",
    "coveredPoints",
    "scoringIssues",
    "clarifications",
    "confidence",
  ]);
  assert.deepEqual(
    RECALL_EVALUATION_JSON_SCHEMA.properties.recallResult.enum,
    ["incorrect", "partial", "correct"],
  );
  assert.equal(RECALL_EVALUATION_JSON_SCHEMA.properties.coveredPoints.maxItems, 32);
  assert.equal(RECALL_EVALUATION_JSON_SCHEMA.properties.confidence.minimum, 0);
  assert.equal(RECALL_EVALUATION_JSON_SCHEMA.properties.confidence.maximum, 1);
});

test("parses only complete type-safe evaluator responses", () => {
  assert.deepEqual(
    parseRecallEvaluationResponse(
      JSON.stringify({
        recallResult: "correct",
        coveredPoints: ["Formula"],
        scoringIssues: [],
        clarifications: [],
        confidence: 0.1,
      }),
    ),
    evaluation({ coveredPoints: ["Formula"], confidence: 0.1 }),
  );

  for (const invalid of [
    "not JSON",
    JSON.stringify({
      recallResult: "correct",
      coveredPoints: ["Formula"],
      scoringIssues: [],
      clarifications: [],
      confidence: "high",
    }),
    JSON.stringify({
      recallResult: "correct",
      coveredPoints: ["Formula"],
      scoringIssues: [],
      confidence: 1,
    }),
    JSON.stringify({
      recallResult: "correct",
      coveredPoints: ["Formula"],
      scoringIssues: [],
      clarifications: [],
      confidence: 1,
      extra: true,
    }),
  ]) {
    assert.throws(() => parseRecallEvaluationResponse(invalid), /Model returned/u);
  }
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
  assert.match(result.feedback, /Additional note/u);
  assert.match(result.feedback, /did not change your result/u);
  assert.doesNotMatch(result.feedback, /Recall (?:Target|Result)/u);
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

test("accepts complete formula answers without supporting symbol definitions", () => {
  const prompt = "What is the formula for the discounted return G_t from time step t?";
  const answers = [
    ["Exact formula", "Mathematical notation"],
    ["Equivalent finite-horizon formula", "Alternative horizon form"],
    ["Equivalent prose formula", "Prose representation"],
  ];

  for (const [covered, clarification] of answers) {
    const result = reconcileRecallEvaluation({
      prompt,
      result: evaluation({
        coveredPoints: [covered],
        clarifications: [clarification],
      }),
    });
    assert.equal(result.recallResult, "correct");
    assert.deepEqual(result.scoringIssues, []);
  }
});

test("keeps substantive formula and multi-claim errors as failed recall", () => {
  const partials = [
    evaluation({
      recallResult: "partial",
      coveredPoints: ["Future rewards"],
      scoringIssues: ["Discounting is missing"],
    }),
    evaluation({
      recallResult: "partial",
      coveredPoints: ["Discounted sum"],
      scoringIssues: ["The gamma exponent is off by one"],
    }),
    evaluation({
      recallResult: "partial",
      coveredPoints: ["Online learning timing"],
      scoringIssues: ["On-policy data identity is missing"],
    }),
  ];
  for (const result of partials) {
    assert.equal(
      reconcileRecallEvaluation({ prompt: "Explain every requested part.", result })
        .recallResult,
      "partial",
    );
  }

  for (const issue of [
    "Described termination probability instead of discounted return",
    "Reversed the two concepts",
    "Incorrectly claimed the concepts are synonyms",
  ]) {
    assert.equal(
      reconcileRecallEvaluation({
        prompt: "State the requested distinction.",
        result: evaluation({
          recallResult: "incorrect",
          coveredPoints: [],
          scoringIssues: [issue],
        }),
      }).recallResult,
      "incorrect",
    );
  }
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

test("accepts valid low-confidence evaluations without retrying", async () => {
  let calls = 0;
  const result = await evaluateRecallWithRetries({
    prompt: "What is PPO?",
    evaluate: async () => {
      calls += 1;
      return evaluation({ confidence: 0 });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.confidence, 0);
  assert.equal(result.recallResult, "correct");
});

test("retries malformed, schema-invalid, and inconsistent evaluations", async () => {
  let calls = 0;
  const result = await evaluateRecallWithRetries({
    prompt: "What is PPO?",
    evaluate: async () => {
      calls += 1;
      if (calls === 1) return parseRecallEvaluationResponse("not JSON");
      if (calls === 2) {
        return parseRecallEvaluationResponse(
          JSON.stringify({
            recallResult: "correct",
            coveredPoints: ["Required knowledge"],
            scoringIssues: [],
            clarifications: [],
            confidence: "high",
          }),
        );
      }
      return evaluation({ confidence: 0.4 });
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.confidence, 0.4);
  assert.equal(result.recallResult, "correct");
});
