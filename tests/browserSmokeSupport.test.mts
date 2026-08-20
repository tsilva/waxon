import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SMOKE_QUESTIONS,
  isBrowserSmokeQuestion,
} from "../app/lib/browserSmokeSupport.ts";

test("browser smoke grading is limited to the two fixture questions", () => {
  assert.equal(BROWSER_SMOKE_QUESTIONS.length, 2);

  for (const fixture of BROWSER_SMOKE_QUESTIONS) {
    assert.equal(isBrowserSmokeQuestion(fixture.prompt), true);
  }

  assert.equal(
    isBrowserSmokeQuestion("An unrelated question in the learner's queue"),
    false,
  );
  assert.equal(
    isBrowserSmokeQuestion(` ${BROWSER_SMOKE_QUESTIONS[0].prompt}`),
    false,
  );
});
