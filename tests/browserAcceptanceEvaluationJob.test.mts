import assert from "node:assert/strict";
import test from "node:test";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";

const TEST_DATABASE_URL =
  process.env.APPLICATION_CONTRACT_TEST_DATABASE_URL ??
  process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

test(
  "request-authorized acceptance evaluation survives production-like Workflow consumption",
  {
    skip: TEST_DATABASE_URL ? false : "A disposable test database is required",
  },
  async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DATABASE_URL_UNPOOLED = TEST_DATABASE_URL;
    const prior = {
      evaluator: process.env.WAXON_BROWSER_SMOKE_EVALUATOR,
      llmKey: process.env.LLM_API_KEY,
      nodeEnv: process.env.NODE_ENV,
      openRouterKey: process.env.OPENROUTER_API_KEY,
      publicIdentity: process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER,
      support: process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT,
    };
    const priorFetch = globalThis.fetch;
    const [
      { getV2Client },
      { waxonApplication },
      support,
      { browserAcceptanceTestLearner },
    ] = await Promise.all([
      import("../app/db/v2/client.ts"),
      import("../app/lib/v2/application.ts"),
      import("../app/lib/browserSmokeSupport.ts"),
      import("../app/lib/localTestAuth.ts"),
    ]);
    const { pool } = getV2Client();
    const learnerId = browserAcceptanceTestLearner.id;
    const otherLearnerId = "issue-20-unauthorized-evaluation-learner";
    const learnerIds = [learnerId, otherLearnerId];
    async function insertQuestion(userId: string, prompt: string) {
      const question = await pool.query<{ id: string }>(
        `INSERT INTO waxon_v2.questions
           (user_id, prompt, reference_answer, lifecycle, target_key)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id`,
        [
          userId,
          prompt,
          support.BROWSER_SMOKE_CORRECT_TOKEN,
          questionPromptKey(prompt),
        ],
      );
      const questionId = question.rows[0]?.id;
      assert.ok(questionId);
      return questionId;
    }
    async function evaluationJobPayload(userId: string, submissionId: string) {
      const job = await pool.query<{
        payload: Record<string, unknown>;
        status: string;
      }>(
        `SELECT payload, status
           FROM waxon_v2.jobs
          WHERE user_id = $1
            AND type = 'evaluate_submission'
            AND idempotency_key = $2`,
        [userId, submissionId],
      );
      const row = job.rows[0];
      assert.ok(row);
      return row;
    }
    try {
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               email = EXCLUDED.email`,
        [
          learnerId,
          browserAcceptanceTestLearner.displayName,
          browserAcceptanceTestLearner.email,
        ],
      );
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               email = EXCLUDED.email`,
        [
          otherLearnerId,
          "Issue 20 unauthorized evaluation learner",
          "issue-20-unauthorized-evaluation@waxon.invalid",
        ],
      );
      const questionId = await insertQuestion(
        learnerId,
        support.BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
      );

      Reflect.set(process.env, "NODE_ENV", "development");
      process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";
      process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";
      delete process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.LLM_API_KEY;
      globalThis.fetch = async () => {
        throw new Error("Acceptance evaluation must not call a live model.");
      };

      const review = waxonApplication.forLearner(learnerId).review;
      const pending = await review.submitAnswer({
        questionId,
        answer: support.BROWSER_SMOKE_CORRECT_TOKEN,
        idempotencyKey: "issue-20-workflow-authorization",
      });
      assert.equal(pending.status, "pending");

      Reflect.set(process.env, "NODE_ENV", "production");
      delete process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT;
      delete process.env.WAXON_BROWSER_SMOKE_EVALUATOR;
      const completed = await review.evaluatePending(pending.submissionId);
      assert.equal(completed.status, "complete");
      assert.equal(completed.grade, "good");
      assert.equal(completed.feedback, "The smoke-test answer matched.");

      const job = await evaluationJobPayload(learnerId, pending.submissionId);
      assert.equal(job.payload.browserAcceptanceEvaluationAuthorized, true);
      assert.equal(job.status, "succeeded");

      const productionQuestionId = await insertQuestion(
        learnerId,
        support.BROWSER_SMOKE_QUESTIONS[0].prompt,
      );
      const productionPending = await review.submitAnswer({
        questionId: productionQuestionId,
        answer: support.BROWSER_SMOKE_CORRECT_TOKEN,
        idempotencyKey: "issue-20-production-authorization-refusal",
      });
      assert.equal(
        "browserAcceptanceEvaluationAuthorized" in
          (await evaluationJobPayload(learnerId, productionPending.submissionId))
            .payload,
        false,
      );

      Reflect.set(process.env, "NODE_ENV", "development");
      process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT = "1";
      process.env.WAXON_BROWSER_SMOKE_EVALUATOR = "1";
      const unnamedQuestionId = await insertQuestion(
        learnerId,
        "Which unnamed acceptance Question must use the normal evaluator?",
      );
      const unnamedPending = await review.submitAnswer({
        questionId: unnamedQuestionId,
        answer: support.BROWSER_SMOKE_CORRECT_TOKEN,
        idempotencyKey: "issue-20-unnamed-authorization-refusal",
      });
      assert.equal(
        "browserAcceptanceEvaluationAuthorized" in
          (await evaluationJobPayload(learnerId, unnamedPending.submissionId))
            .payload,
        false,
      );

      const otherQuestionId = await insertQuestion(
        otherLearnerId,
        support.BROWSER_SMOKE_TIMEZONE_QUESTION.prompt,
      );
      const otherPending = await waxonApplication
        .forLearner(otherLearnerId)
        .review.submitAnswer({
          questionId: otherQuestionId,
          answer: support.BROWSER_SMOKE_CORRECT_TOKEN,
          idempotencyKey: "issue-20-other-learner-authorization-refusal",
        });
      assert.equal(
        "browserAcceptanceEvaluationAuthorized" in
          (
            await evaluationJobPayload(
              otherLearnerId,
              otherPending.submissionId,
            )
          ).payload,
        false,
      );
    } finally {
      globalThis.fetch = priorFetch;
      await pool.query(
        `DELETE FROM waxon_v2.answer_submissions
          WHERE user_id = ANY($1::text[])`,
        [learnerIds],
      );
      await pool.query(
        `DELETE FROM waxon_v2.questions WHERE user_id = ANY($1::text[])`,
        [learnerIds],
      );
      await pool.query(`DELETE FROM waxon_v2.users WHERE id = ANY($1::text[])`, [
        learnerIds,
      ]);
      await pool.end();
      for (const [key, value] of Object.entries({
        WAXON_BROWSER_SMOKE_EVALUATOR: prior.evaluator,
        LLM_API_KEY: prior.llmKey,
        NODE_ENV: prior.nodeEnv,
        OPENROUTER_API_KEY: prior.openRouterKey,
        NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER: prior.publicIdentity,
        WAXON_ENABLE_BROWSER_SMOKE_SUPPORT: prior.support,
      })) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else Reflect.set(process.env, key, value);
      }
    }
  },
);
