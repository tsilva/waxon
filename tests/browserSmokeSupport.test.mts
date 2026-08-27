import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SMOKE_ISOLATION_QUESTION,
  BROWSER_SMOKE_LIBRARY_QUESTION_PROMPT,
  BROWSER_SMOKE_QUESTIONS,
  BROWSER_SMOKE_TIMEZONE_QUESTION,
  isBrowserSmokeQuestion,
} from "../app/lib/browserSmokeSupport.ts";
import {
  browserAcceptanceTestUser,
  getLocalTestUser,
  localTestUser,
} from "../app/lib/localTestAuth.ts";

test("browser acceptance grading is limited to the named Library and Review fixture Questions", () => {
  assert.equal(BROWSER_SMOKE_QUESTIONS.length, 5);
  assert.equal(
    isBrowserSmokeQuestion(BROWSER_SMOKE_LIBRARY_QUESTION_PROMPT),
    true,
  );
  assert.equal(
    isBrowserSmokeQuestion(BROWSER_SMOKE_TIMEZONE_QUESTION.prompt),
    true,
  );

  for (const fixture of BROWSER_SMOKE_QUESTIONS) {
    assert.equal(isBrowserSmokeQuestion(fixture.prompt), true);
    assert.match(fixture.prompt, /^Issue 20 Review \d:/u);
  }

  assert.equal(
    isBrowserSmokeQuestion("An unrelated question in the learner's queue"),
    false,
  );
  assert.equal(
    isBrowserSmokeQuestion(` ${BROWSER_SMOKE_QUESTIONS[0].prompt}`),
    false,
  );
  assert.equal(
    isBrowserSmokeQuestion(BROWSER_SMOKE_ISOLATION_QUESTION.prompt),
    false,
  );
});

test("browser acceptance mode selects a dedicated local Learner", () => {
  const prior = process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
  try {
    delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    assert.deepEqual(getLocalTestUser(), localTestUser);
    process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = "1";
    assert.deepEqual(getLocalTestUser(), browserAcceptanceTestUser);
    assert.match(browserAcceptanceTestUser.email, /@waxon\.invalid$/u);
    assert.notEqual(browserAcceptanceTestUser.email, localTestUser.email);
  } finally {
    if (prior === undefined) {
      delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    } else {
      process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = prior;
    }
  }
});
