import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SMOKE_ISOLATION_QUESTION,
  BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
  BROWSER_SMOKE_QUESTIONS,
  BROWSER_SMOKE_TIMEZONE_QUESTION,
  isBrowserSmokeQuestion,
  shouldUseBrowserAcceptanceEvaluator,
} from "../app/lib/browserSmokeSupport.ts";
import {
  browserAcceptanceTestLearner,
  getLocalTestLearner,
  localTestUser,
} from "../app/lib/localTestAuth.ts";

test("browser acceptance grading is limited to the named Question Bank and Review fixture Questions", () => {
  assert.equal(BROWSER_SMOKE_QUESTIONS.length, 5);
  assert.equal(
    isBrowserSmokeQuestion(BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT),
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
    assert.deepEqual(getLocalTestLearner(), localTestUser);
    process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = "1";
    assert.deepEqual(getLocalTestLearner(), browserAcceptanceTestLearner);
    assert.match(browserAcceptanceTestLearner.email, /@waxon\.invalid$/u);
    assert.notEqual(browserAcceptanceTestLearner.email, localTestUser.email);
  } finally {
    if (prior === undefined) {
      delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    } else {
      process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = prior;
    }
  }
});

test("deterministic evaluation requires development acceptance mode and its dedicated Learner", () => {
  const prior = {
    acceptance: process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER,
    evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    Reflect.set(process.env, "NODE_ENV", "development");
    process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = "1";
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";

    assert.equal(
      shouldUseBrowserAcceptanceEvaluator({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      true,
    );
    assert.equal(
      shouldUseBrowserAcceptanceEvaluator({
        learnerId: "another-learner",
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "another Learner must use the normal evaluator",
    );

    Reflect.set(process.env, "NODE_ENV", "production");
    assert.equal(
      shouldUseBrowserAcceptanceEvaluator({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "production must use the normal evaluator",
    );

    Reflect.set(process.env, "NODE_ENV", "development");
    delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    assert.equal(
      shouldUseBrowserAcceptanceEvaluator({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "development without acceptance mode must use the normal evaluator",
    );
  } finally {
    for (const [key, value] of Object.entries({
      NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER: prior.acceptance,
      WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
      NODE_ENV: prior.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("production and other Learners reach the normal evaluator for acceptance fixture Prompts", async () => {
  const prior = {
    acceptance: process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER,
    databaseUrl: process.env.DATABASE_URL,
    evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
    nodeEnv: process.env.NODE_ENV,
    openRouterKey: process.env.OPENROUTER_API_KEY,
  };
  const priorFetch = globalThis.fetch;
  const normalEvaluatorLearners: string[] = [];
  try {
    process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = "1";
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";
    process.env.OPENROUTER_API_KEY = "test-only-key";
    delete process.env.DATABASE_URL;
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        user: string;
      };
      normalEvaluatorLearners.push(request.user);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.75,
                  coveredPoints: ["Normal evaluator"],
                  demonstratedGap: null,
                  expectedAnswer: "Normal evaluator response",
                  feedback: "Normal evaluator response",
                  grade: "good",
                  missingPoints: [],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const { evaluateRecall } = await import("../app/lib/v2/model.ts");

    Reflect.set(process.env, "NODE_ENV", "development");
    const otherLearnerResult = await evaluateRecall({
      userId: "another-learner",
      prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      referenceAnswer: "A fixture Answer Standard",
      answer: BROWSER_SMOKE_QUESTIONS[0].referenceAnswer,
    });
    assert.equal(otherLearnerResult.feedback, "Normal evaluator response");

    Reflect.set(process.env, "NODE_ENV", "production");
    const productionResult = await evaluateRecall({
      userId: browserAcceptanceTestLearner.id,
      prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      referenceAnswer: "A fixture Answer Standard",
      answer: BROWSER_SMOKE_QUESTIONS[0].referenceAnswer,
    });
    assert.equal(productionResult.feedback, "Normal evaluator response");
    assert.deepEqual(normalEvaluatorLearners, [
      "another-learner",
      browserAcceptanceTestLearner.id,
    ]);
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries({
      NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER: prior.acceptance,
      DATABASE_URL: prior.databaseUrl,
      WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
      NODE_ENV: prior.nodeEnv,
      OPENROUTER_API_KEY: prior.openRouterKey,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
});
