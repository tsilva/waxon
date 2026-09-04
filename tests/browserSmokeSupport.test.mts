import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BROWSER_SMOKE_ISOLATION_QUESTION,
  BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
  BROWSER_SMOKE_QUESTIONS,
  BROWSER_SMOKE_TIMEZONE_QUESTION,
  authorizeBrowserAcceptanceEvaluation,
  isBrowserSmokeQuestion,
  shouldUseBrowserAcceptanceEvaluator,
} from "../app/lib/browserSmokeSupport.ts";
import {
  browserAcceptanceTestLearner,
  getLocalTestLearner,
  localTestUser,
} from "../app/lib/localTestAuth.ts";

test("acceptance evaluator authorization does not depend on the hot-reloaded auth module", () => {
  const supportSource = readFileSync(
    new URL("../app/lib/browserSmokeSupport.ts", import.meta.url),
    "utf8",
  );
  const identitySource = readFileSync(
    new URL("../app/lib/browserAcceptanceIdentity.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    supportSource,
    /from ["']@\/app\/lib\/localTestAuth["']/u,
  );
  assert.doesNotMatch(identitySource, /^\s*import\s/mu);
});

test("browser acceptance grading is limited to the named Library and Review fixture Questions", () => {
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

test("request-time evaluation authorization requires every server safety condition", () => {
  const prior = {
    evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
    nodeEnv: process.env.NODE_ENV,
    publicIdentity: process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER,
    support: process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT,
  };
  try {
    Reflect.set(process.env, "NODE_ENV", "development");
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";
    process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER = "1";
    delete process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT;

    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "the public identity flag must not enable server evaluation support",
    );

    delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    Reflect.set(process.env, "NODE_ENV", "development");
    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";

    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      true,
    );
    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: "another-learner",
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "another Learner must use the normal evaluator",
    );

    Reflect.set(process.env, "NODE_ENV", "production");
    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "production must use the normal evaluator",
    );

    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";
    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: "An unnamed acceptance Question",
      }),
      false,
      "an unnamed Prompt must not receive an authorization marker",
    );

    delete process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT;
    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "development without server acceptance support must use the normal evaluator",
    );

    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";
    delete process.env.WAXON_BROWSER_SMOKE_EVALUATOR;
    assert.equal(
      authorizeBrowserAcceptanceEvaluation({
        learnerId: browserAcceptanceTestLearner.id,
        prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      }),
      false,
      "development without the evaluator flag must use the normal evaluator",
    );
  } finally {
    for (const [key, value] of Object.entries({
      WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
      NODE_ENV: prior.nodeEnv,
      NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER: prior.publicIdentity,
      WAXON_ENABLE_BROWSER_SMOKE_SUPPORT: prior.support,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("job-time evaluation requires the persisted marker and revalidates Learner and Prompt", () => {
  assert.equal(
    shouldUseBrowserAcceptanceEvaluator({
      authorized: true,
      learnerId: browserAcceptanceTestLearner.id,
      prompt: BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
    }),
    true,
  );
  assert.equal(
    shouldUseBrowserAcceptanceEvaluator({
      authorized: false,
      learnerId: browserAcceptanceTestLearner.id,
      prompt: BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
    }),
    false,
  );
  assert.equal(
    shouldUseBrowserAcceptanceEvaluator({
      authorized: true,
      learnerId: "another-learner",
      prompt: BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
    }),
    false,
  );
  assert.equal(
    shouldUseBrowserAcceptanceEvaluator({
      authorized: true,
      learnerId: browserAcceptanceTestLearner.id,
      prompt: "An unnamed acceptance Question",
    }),
    false,
  );
});

test("an authorized job evaluates without request environment or a model key", async () => {
  const prior = {
    evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
    nodeEnv: process.env.NODE_ENV,
    openRouterKey: process.env.OPENROUTER_API_KEY,
    publicIdentity: process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER,
    support: process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT,
  };
  const priorFetch = globalThis.fetch;
  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    delete process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT;
    delete process.env.WAXON_BROWSER_SMOKE_EVALUATOR;
    delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = async () => {
      throw new Error("The normal evaluator must not be called.");
    };
    const { evaluateRecall } = await import("../app/lib/v2/model.ts");
    const result = await evaluateRecall({
      userId: browserAcceptanceTestLearner.id,
      prompt: BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
      referenceAnswer: "A fixture Answer Standard",
      answer: BROWSER_SMOKE_QUESTIONS[0].referenceAnswer,
      browserAcceptanceEvaluationAuthorized: true,
    });

    assert.equal(result.recallResult, "correct");
    assert.equal(
      result.feedback,
      "Correct. Your answer covered everything needed.",
    );
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries({
      WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
      NODE_ENV: prior.nodeEnv,
      OPENROUTER_API_KEY: prior.openRouterKey,
      NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER: prior.publicIdentity,
      WAXON_ENABLE_BROWSER_SMOKE_SUPPORT: prior.support,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
});

test("production and other Learners reach the normal evaluator for acceptance fixture Prompts", async () => {
  const prior = {
    databaseUrl: process.env.DATABASE_URL,
    evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
    nodeEnv: process.env.NODE_ENV,
    openRouterKey: process.env.OPENROUTER_API_KEY,
    support: process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT,
  };
  const priorFetch = globalThis.fetch;
  const normalEvaluatorLearners: string[] = [];
  try {
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";
    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";
    process.env.OPENROUTER_API_KEY = "test-only-key";
    delete process.env.DATABASE_URL;
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        provider: { require_parameters: boolean };
        response_format: { type: string; json_schema: { strict: boolean } };
        user: string;
      };
      normalEvaluatorLearners.push(request.user);
      assert.equal(request.provider.require_parameters, true);
      assert.equal(request.response_format.type, "json_schema");
      assert.equal(request.response_format.json_schema.strict, true);
      return new Response(
        JSON.stringify({
          model: request.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.75,
                  coveredPoints: ["Normal evaluator"],
                  recallResult: "correct",
                  scoringIssues: [],
                  clarifications: [],
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
      browserAcceptanceEvaluationAuthorized: true,
    });
    assert.equal(otherLearnerResult.recallResult, "correct");

    Reflect.set(process.env, "NODE_ENV", "production");
    const productionResult = await evaluateRecall({
      userId: browserAcceptanceTestLearner.id,
      prompt: BROWSER_SMOKE_QUESTIONS[0].prompt,
      referenceAnswer: "A fixture Answer Standard",
      answer: BROWSER_SMOKE_QUESTIONS[0].referenceAnswer,
    });
    assert.equal(productionResult.recallResult, "correct");
    assert.deepEqual(normalEvaluatorLearners, [
      "another-learner",
      browserAcceptanceTestLearner.id,
    ]);
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries({
      DATABASE_URL: prior.databaseUrl,
      WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
      NODE_ENV: prior.nodeEnv,
      OPENROUTER_API_KEY: prior.openRouterKey,
      WAXON_ENABLE_BROWSER_SMOKE_SUPPORT: prior.support,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
});
