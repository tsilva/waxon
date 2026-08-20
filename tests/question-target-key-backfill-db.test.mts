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
           (id, user_id, lifecycle, target_key)
         VALUES ($1, $2, 'new', $3)`,
        [questionId, userId, `legacy:${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO waxon_v2.question_versions
           (user_id, question_id, version, prompt, reference_answer,
            display_answer, answer_mode)
         VALUES ($1, $2, 1, $3, $4, $4, 'semantic')`,
        [userId, questionId, prompt, answer],
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
        `SELECT question.target_key, version.prompt, version.reference_answer
           FROM waxon_v2.questions question
           JOIN waxon_v2.question_versions version
             ON version.user_id = question.user_id
            AND version.question_id = question.id
            AND version.is_current = true
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
