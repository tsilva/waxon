import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";
import { backfillQuestionTargetKeys } from "../scripts/question-target-key-backfill.mts";

const testDatabaseUrl = process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

test(
  "target-key backfill repairs legacy rows once without changing question content",
  { skip: testDatabaseUrl ? false : "QUESTION_SEARCH_TEST_DATABASE_URL is not set" },
  async () => {
    if (!testDatabaseUrl) return;
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const userId = `target-key-repair-${randomUUID()}`;
    const questionId = randomUUID();
    const prompt = "What does a production data migration marker prevent?";
    const answer = "It prevents an already-completed repair from running again.";

    try {
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, 'Target key repair', $1 || '@example.test')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO waxon_v2.questions
           (id, user_id, prompt, reference_answer, lifecycle, target_key)
         VALUES ($1, $2, $3, $4, 'active', $5)`,
        [questionId, userId, prompt, answer, `legacy:${randomUUID()}`],
      );
      await pool.query(
        `DELETE FROM waxon_v2.data_migration_markers
          WHERE name = 'question-prompt-keys-v1'`,
      );

      const first = await backfillQuestionTargetKeys(pool);
      assert.equal(first.status, "applied");
      const repaired = await pool.query<{
        target_key: string;
        prompt: string;
        reference_answer: string;
      }>(
        `SELECT question.target_key, question.prompt, question.reference_answer
           FROM waxon_v2.questions question
          WHERE question.user_id = $1 AND question.id = $2`,
        [userId, questionId],
      );
      assert.deepEqual(repaired.rows, [
        { target_key: questionPromptKey(prompt), prompt, reference_answer: answer },
      ]);

      const second = await backfillQuestionTargetKeys(pool);
      assert.deepEqual(second, {
        status: "already_applied",
        scanned: 0,
        updated: 0,
        activeDuplicatesPreserved: 0,
      });
    } finally {
      await pool.query(`DELETE FROM waxon_v2.users WHERE id = $1`, [userId]);
      await pool.query(
        `DELETE FROM waxon_v2.data_migration_markers
          WHERE name = 'question-prompt-keys-v1'`,
      );
      await pool.end();
    }
  },
);
