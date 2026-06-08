import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuestionExtractionProgress } from "../app/lib/questionGenerationProgress.ts";

test("calculateQuestionExtractionProgress is based on extracted questions", () => {
  assert.equal(
    calculateQuestionExtractionProgress({ generated: 0, total: 50 }),
    0,
  );
  assert.equal(
    calculateQuestionExtractionProgress({ generated: 25, total: 50 }),
    50,
  );
  assert.equal(
    calculateQuestionExtractionProgress({ generated: 50, total: 50 }),
    100,
  );
});

test("calculateQuestionExtractionProgress clamps invalid or excessive values", () => {
  assert.equal(
    calculateQuestionExtractionProgress({ generated: -1, total: 50 }),
    0,
  );
  assert.equal(
    calculateQuestionExtractionProgress({ generated: 75, total: 50 }),
    100,
  );
  assert.equal(
    calculateQuestionExtractionProgress({ generated: 1, total: 0 }),
    100,
  );
});
