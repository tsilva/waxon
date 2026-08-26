import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";

const testDatabaseUrl = process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

test(
  "question search isolates users, includes inactive exact matches, and ranks lexical matches",
  { skip: testDatabaseUrl ? false : "QUESTION_SEARCH_TEST_DATABASE_URL is not set" },
  async () => {
    if (!testDatabaseUrl) return;
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = testDatabaseUrl;
    process.env.WAXON_QUESTION_SEARCH_MODE = "lexical";
    const { checkQuestions, rankQuestionIdsLexically } = await import(
      "../app/lib/v2/questionSearch.ts"
    );
    const { getV2Client } = await import("../app/db/v2/client.ts");
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const userA = `question-search-a-${randomUUID()}`;
    const userB = `question-search-b-${randomUUID()}`;
    const exactPrompt = "What property makes an HTTP operation idempotent?";
    const lexicalPrompt = "How does an idempotency key prevent duplicate creation?";

    async function addQuestion(input: {
      userId: string;
      prompt: string;
      answer: string;
      lifecycle: "active" | "archived";
    }) {
      const questionId = randomUUID();
      await pool.query(
        `INSERT INTO waxon_v2.questions
           (id, user_id, prompt, reference_answer, lifecycle, target_key)
         VALUES ($1, $2, $3, $4, $5::waxon_v2.question_lifecycle, $6)`,
        [
          questionId,
          input.userId,
          input.prompt,
          input.answer,
          input.lifecycle,
          questionPromptKey(input.prompt),
        ],
      );
      return questionId;
    }

    try {
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, 'Search A', $1 || '@example.test'),
                ($2, 'Search B', $2 || '@example.test')`,
        [userA, userB],
      );
      const archivedId = await addQuestion({
        userId: userA,
        prompt: exactPrompt,
        answer: "Repeating it has the same intended effect as doing it once.",
        lifecycle: "archived",
      });
      const lexicalId = await addQuestion({
        userId: userA,
        prompt: lexicalPrompt,
        answer: "The server reuses the recorded result for the same key.",
        lifecycle: "active",
      });
      await addQuestion({
        userId: userB,
        prompt: exactPrompt,
        answer: "This other learner's answer must remain isolated.",
        lifecycle: "active",
      });

      const exact = await checkQuestions({
        userId: userA,
        items: [
          {
            candidateId: "exact",
            prompt: `  ${exactPrompt.toUpperCase()}  `,
            referenceAnswer: "candidate answer",
          },
        ],
      });
      assert.equal(exact.results[0]?.advisory, "exact_duplicate");
      assert.deepEqual(
        exact.results[0]?.matches.map((match) => match.id),
        [archivedId],
      );
      assert.equal(exact.results[0]?.matches[0]?.lifecycle, "archived");
      assert.deepEqual(
        await rankQuestionIdsLexically({
          userId: userA,
          query: ` ${exactPrompt.toUpperCase()} `,
          lifecycle: "archived",
          limit: 10,
        }),
        [archivedId],
      );

      const lexical = await checkQuestions({
        userId: userA,
        items: [
          {
            candidateId: "lexical",
            prompt: "How can an idempotency key stop duplicate creation?",
            referenceAnswer: "By associating retries with one stored result.",
          },
        ],
      });
      assert.equal(lexical.results[0]?.advisory, "review_similar");
      assert.equal(lexical.results[0]?.matches[0]?.id, lexicalId);
      assert.equal(
        lexical.results[0]?.matches[0]?.matchTypes.some(
          (matchType) => matchType === "full_text" || matchType === "trigram",
        ),
        true,
      );

      const batch = await checkQuestions({
        userId: userA,
        items: [
          {
            candidateId: "first",
            prompt: "What is a novel batch-only target?",
            referenceAnswer: "A.",
          },
          {
            candidateId: "second",
            prompt: " WHAT IS A NOVEL BATCH-ONLY TARGET? ",
            referenceAnswer: "A.",
          },
          {
            candidateId: "third",
            prompt: "What is a novel batch-only recall target?",
            referenceAnswer: "A distinct proposed answer.",
          },
        ],
      });
      assert.equal(batch.results[1]?.advisory, "exact_duplicate");
      assert.equal(batch.results[1]?.matches[0]?.origin, "batch");
      assert.equal(batch.results[1]?.matches[0]?.candidateId, "first");
      assert.equal(batch.results[2]?.advisory, "review_similar");
      assert.equal(batch.results[2]?.matches[0]?.origin, "batch");
      assert.equal(batch.results[2]?.matches[0]?.candidateId, "first");

      const embeddingJobId = randomUUID();
      await pool.query(
        `INSERT INTO waxon_v2.jobs
           (id, user_id, type, idempotency_key, priority, payload)
         VALUES ($1, $2, 'embed_question_batch', $3, 2, $4::jsonb)`,
        [
          embeddingJobId,
          userA,
          `test-${embeddingJobId}`,
          JSON.stringify({ questionIds: [lexicalId] }),
        ],
      );
      const priorFetch = globalThis.fetch;
      const priorOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "question-search-test-key";
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                index: 0,
                embedding: Array.from({ length: 512 }, (_, index) =>
                  index === 0 ? 1 : 0,
                ),
              },
            ],
            usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.000001 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      try {
        const { runQuestionEmbeddingJob } = await import(
          "../app/lib/v2/questionEmbeddings.ts"
        );
        await runQuestionEmbeddingJob(embeddingJobId);
      } finally {
        globalThis.fetch = priorFetch;
        if (priorOpenRouterApiKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = priorOpenRouterApiKey;
        }
      }
      const embedded = await pool.query<{ question_id: string }>(
        `SELECT question_id
           FROM waxon_v2.question_search_embeddings
          WHERE user_id = $1 AND question_id = $2`,
        [userA, lexicalId],
      );
      const completedJob = await pool.query<{ status: string }>(
        `SELECT status::text FROM waxon_v2.jobs WHERE id = $1`,
        [embeddingJobId],
      );
      assert.deepEqual(embedded.rows.map((row) => row.question_id), [lexicalId]);
      assert.equal(completedJob.rows[0]?.status, "succeeded");
    } finally {
      await pool.query(`DELETE FROM waxon_v2.users WHERE id = ANY($1::text[])`, [
        [userA, userB],
      ]);
      await pool.end();
      await getV2Client().pool.end();
    }
  },
);
