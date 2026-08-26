import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";

const testDatabaseUrl =
  process.env.APPLICATION_CONTRACT_TEST_DATABASE_URL ??
  process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

async function migrationSql(tag: string, schemaName: string): Promise<string> {
  const source = await readFile(
    new URL(`../drizzle-v2/${tag}.sql`, import.meta.url),
    "utf8",
  );
  return source.replaceAll("waxon_v2", schemaName);
}

async function applySql(client: PoolClient, source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

test(
  "issue #18 upgrades seeded 0016 Questions and Learning Evidence without compatibility storage",
  { skip: testDatabaseUrl ? false : "A contract test database URL is not set" },
  async () => {
    if (!testDatabaseUrl) return;
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const client = await pool.connect();
    const schemaName = `waxon_issue18_${randomUUID().replaceAll("-", "")}`;
    const learnerId = `issue18-migration-${randomUUID()}`;
    const foreignLearnerId = `issue18-migration-foreign-${randomUUID()}`;
    const foreignQuestionId = randomUUID();
    const foreignVersionId = randomUUID();
    const questionId = randomUUID();
    const oldVersionId = randomUUID();
    const currentVersionId = randomUUID();
    const legacyDuplicateQuestionId = randomUUID();
    const legacyDuplicateVersionId = randomUUID();
    const singleQuestionId = randomUUID();
    const singleVersionId = randomUUID();
    const flaggedQuestionId = randomUUID();
    const archivedQuestionId = randomUUID();
    const orphanQuestionId = randomUUID();
    const oldSubmissionId = randomUUID();
    const oldEvaluationId = randomUUID();
    const oldGradeEventId = randomUUID();
    const currentSubmissionId = randomUUID();
    const currentEvaluationId = randomUUID();
    const currentGradeEventId = randomUUID();
    const currentPrompt =
      "IİΣ Ｑuestion\u00a0identity owns\u2003Learning\u0085Evidence?";
    const currentAnswer = "The immutable Question identity owns it directly.";
    const currentPromptKey = questionPromptKey(currentPrompt);
    const legacyDuplicateTargetKey =
      `duplicate:${currentPromptKey}:${legacyDuplicateQuestionId}`;
    const zeroVector = `[${Array.from({ length: 512 }, () => "0").join(",")}]`;

    try {
      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle-v2/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ) as MigrationJournal;
      for (const entry of journal.entries.filter((candidate) => candidate.idx <= 16)) {
        await client.query("BEGIN");
        try {
          await applySql(client, await migrationSql(entry.tag, schemaName));
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }

      await client.query(
        `INSERT INTO ${schemaName}.users (id, display_name, email)
         VALUES
           ($1, 'Issue 18 migration learner', $1 || '@example.test'),
           ($2, 'Issue 18 foreign learner', $2 || '@example.test')`,
        [learnerId, foreignLearnerId],
      );
      await client.query(
        `INSERT INTO ${schemaName}.questions
           (id, user_id, lifecycle, target_key)
         VALUES ($1, $2, 'new', 'foreign-question')`,
        [foreignQuestionId, foreignLearnerId],
      );
      await client.query(
        `INSERT INTO ${schemaName}.question_versions
           (id, user_id, question_id, version, is_current, prompt,
            reference_answer, display_answer, answer_mode)
         VALUES ($1, $2, $3, 1, true, 'Foreign prompt',
                 'Foreign answer', 'Foreign answer', 'semantic')`,
        [foreignVersionId, foreignLearnerId, foreignQuestionId],
      );
      await client.query(
        `INSERT INTO ${schemaName}.questions
           (id, user_id, lifecycle, target_key)
         VALUES
           ($1, $4, 'learning', $7),
           ($2, $4, 'flagged', 'flagged-question'),
           ($3, $4, 'paused', 'archived-question'),
           ($5, $4, 'new', 'orphan-question'),
           ($6, $4, 'review', 'single-version-question'),
           ($8, $4, 'review', $9)`,
        [
          questionId,
          flaggedQuestionId,
          archivedQuestionId,
          learnerId,
          orphanQuestionId,
          singleQuestionId,
          currentPromptKey,
          legacyDuplicateQuestionId,
          legacyDuplicateTargetKey,
        ],
      );
      await client.query(
        `INSERT INTO ${schemaName}.question_versions
           (id, user_id, question_id, version, is_current, prompt,
            reference_answer, display_answer, answer_mode)
         VALUES
           ($1, $3, $4, 1, false, $5,
            'Obsolete mutable answer', 'Obsolete mutable answer', 'exact'),
           ($2, $3, $4, 2, true, $5, $6, $6, 'semantic'),
           (gen_random_uuid(), $3, $7, 1, true, 'Flagged prompt',
            'Flagged answer', 'Flagged answer', 'rubric'),
           (gen_random_uuid(), $3, $8, 1, true, 'Archived prompt',
            'Archived answer', 'Archived answer', 'semantic'),
           ($9, $3, $10, 1, true, 'Single-version prompt',
            'Single-version answer', 'Single-version answer', 'semantic'),
           ($11, $3, $12, 1, true, $5,
            'Repaired duplicate answer', 'Repaired duplicate answer', 'semantic')`,
        [
          oldVersionId,
          currentVersionId,
          learnerId,
          questionId,
          currentPrompt,
          currentAnswer,
          flaggedQuestionId,
          archivedQuestionId,
          singleVersionId,
          singleQuestionId,
          legacyDuplicateVersionId,
          legacyDuplicateQuestionId,
        ],
      );
      await client.query(
        `INSERT INTO ${schemaName}.answer_submissions
           (id, user_id, question_id, question_version_id, answer, status,
            submitted_at)
         VALUES
           ($1, $3, $4, $5, 'The obsolete mutable answer.', 'graded',
            '2030-08-19T10:00:00Z'),
           ($2, $3, $4, $6, 'The immutable Question.', 'graded',
            '2030-08-20T10:00:00Z')`,
        [
          oldSubmissionId,
          currentSubmissionId,
          learnerId,
          questionId,
          oldVersionId,
          currentVersionId,
        ],
      );
      await client.query(
        `INSERT INTO ${schemaName}.evaluations
           (id, user_id, submission_id, status, evaluator, proposed_grade,
            feedback, expected_answer, demonstrated_gap, confidence,
            completed_at)
         VALUES
           ($1, $3, $4, 'complete', 'model', 'again',
            'Historical feedback', 'Obsolete mutable answer', 'Old gap', 0.8,
            '2030-08-19T10:00:01Z'),
           ($2, $3, $5, 'complete', 'model', 'good',
            'Current feedback', $6, 'No gap', 1,
            '2030-08-20T10:00:01Z')`,
        [
          oldEvaluationId,
          currentEvaluationId,
          learnerId,
          oldSubmissionId,
          currentSubmissionId,
          currentAnswer,
        ],
      );
      await client.query(
        `INSERT INTO ${schemaName}.grade_events
           (id, user_id, submission_id, grade, origin, evaluation_id,
            created_at)
         VALUES
           ($1, $3, $4, 'again', 'model', $5,
            '2030-08-19T10:00:02Z'),
           ($2, $3, $6, 'good', 'model', $7,
            '2030-08-20T10:00:02Z')`,
        [
          oldGradeEventId,
          currentGradeEventId,
          learnerId,
          oldSubmissionId,
          oldEvaluationId,
          currentSubmissionId,
          currentEvaluationId,
        ],
      );
      await client.query(
        `INSERT INTO ${schemaName}.memory_states
           (user_id, question_id, due_at, due_on, last_review_at, stability,
            difficulty, elapsed_days, scheduled_days, reps, lapses, state,
            learning_steps, scheduler_version)
         VALUES
           ($1, $2, '2030-08-25T00:00:00Z', '2030-08-25',
            '2030-08-20T10:00:02Z', 4, 5, 1, 5, 2, 1, 2, 0, 'fsrs-6'),
           ($1, $3, '2030-08-26T00:00:00Z', '2030-08-26',
            '2030-08-20T10:00:02Z', 6, 4, 1, 6, 1, 0, 2, 0, 'fsrs-6')`,
        [learnerId, questionId, singleQuestionId],
      );
      await client.query(
        `INSERT INTO ${schemaName}.question_search_embeddings
           (user_id, question_id, question_version_id, model, source_version,
            source_hash, embedding)
         VALUES
           ($1, $2, $3, 'test-embedding', 1, 'current-retained-hash',
            $4::halfvec),
           ($1, $2, $5, 'test-embedding', 2, 'historical-retained-hash',
            $4::halfvec)`,
        [learnerId, questionId, currentVersionId, zeroVector, oldVersionId],
      );
      await client.query(
        `INSERT INTO ${schemaName}.mutation_receipts
           (user_id, scope, key, request_hash, response)
         VALUES ($1, 'library-add-questions', 'legacy-add', 'legacy-hash', $2::jsonb)`,
        [
          learnerId,
          JSON.stringify({
            results: [
              {
                id: questionId,
                prompt: currentPrompt,
                referenceAnswer: currentAnswer,
                lifecycle: "learning",
                outcome: "inserted",
              },
            ],
          }),
        ],
      );

      const issue18 = journal.entries.find((entry) => entry.idx === 17);
      assert.ok(issue18);
      const issue18Sql = await migrationSql(issue18.tag, schemaName);

      await client.query("BEGIN");
      await assert.rejects(
        applySql(client, issue18Sql),
        /Questions without canonical content/u,
      );
      await client.query("ROLLBACK");
      assert.equal(
        (
          await client.query<{ exists: boolean }>(
            `SELECT to_regclass('${schemaName}.question_versions') IS NOT NULL AS exists`,
          )
        ).rows[0]?.exists,
        true,
      );

      await client.query(
        `DELETE FROM ${schemaName}.questions WHERE id = $1`,
        [orphanQuestionId],
      );
      const validReceiptResult = { id: questionId, lifecycle: "learning" };
      for (const invalidReceipt of [
        { key: "missing-lifecycle", response: { results: [{ id: questionId }] } },
        { key: "non-object-result", response: { results: [42] } },
        { key: "empty-results", response: { results: [] } },
        {
          key: "too-many-results",
          response: { results: Array.from({ length: 51 }, () => validReceiptResult) },
        },
        {
          key: "non-string-id",
          response: { results: [{ id: 42, lifecycle: "learning" }] },
        },
        {
          key: "non-uuid-id",
          response: { results: [{ id: "not-a-uuid", lifecycle: "learning" }] },
        },
        {
          key: "wrong-learner-id",
          response: {
            results: [{ id: foreignQuestionId, lifecycle: "learning" }],
          },
        },
      ]) {
        await client.query(
          `INSERT INTO ${schemaName}.mutation_receipts
             (user_id, scope, key, request_hash, response)
           VALUES ($1, 'library-add-questions', $2, 'invalid-hash', $3::jsonb)`,
          [learnerId, invalidReceipt.key, JSON.stringify(invalidReceipt.response)],
        );
        await client.query("BEGIN");
        await assert.rejects(
          applySql(client, issue18Sql),
          /add receipts with invalid public result data/u,
        );
        await client.query("ROLLBACK");
        assert.equal(
          (
            await client.query<{ exists: boolean }>(
              `SELECT to_regclass('${schemaName}.question_versions') IS NOT NULL AS exists`,
            )
          ).rows[0]?.exists,
          true,
        );
        assert.deepEqual(
          (
            await client.query<{ response: unknown }>(
              `SELECT response FROM ${schemaName}.mutation_receipts
                WHERE user_id = $1 AND scope = 'library-add-questions'
                  AND key = $2`,
              [learnerId, invalidReceipt.key],
            )
          ).rows,
          [{ response: invalidReceipt.response }],
        );
        await client.query(
          `DELETE FROM ${schemaName}.mutation_receipts
            WHERE user_id = $1 AND scope = 'library-add-questions'
              AND key = $2`,
          [learnerId, invalidReceipt.key],
        );
      }
      await client.query("BEGIN");
      try {
        await applySql(client, issue18Sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      const retainedQuestion = await client.query<{
        id: string;
        prompt: string;
        reference_answer: string;
        lifecycle: string;
      }>(
        `SELECT id, prompt, reference_answer, lifecycle::text
           FROM ${schemaName}.questions WHERE id = $1`,
        [questionId],
      );
      assert.deepEqual(retainedQuestion.rows, [
        {
          id: questionId,
          prompt: currentPrompt,
          reference_answer: currentAnswer,
          lifecycle: "active",
        },
      ]);
      const retainedLegacyDuplicate = await client.query<{
        id: string;
        prompt: string;
        lifecycle: string;
        target_key: string;
      }>(
        `SELECT id, prompt, lifecycle::text, target_key
           FROM ${schemaName}.questions WHERE id = $1`,
        [legacyDuplicateQuestionId],
      );
      assert.deepEqual(retainedLegacyDuplicate.rows, [
        {
          id: legacyDuplicateQuestionId,
          prompt: currentPrompt,
          lifecycle: "active",
          target_key: legacyDuplicateTargetKey,
        },
      ]);
      const historicalQuestion = await client.query<{
        id: string;
        prompt: string;
        reference_answer: string;
        lifecycle: string;
        target_key: string;
      }>(
        `SELECT id, prompt, reference_answer, lifecycle::text, target_key
           FROM ${schemaName}.questions WHERE id = $1`,
        [oldVersionId],
      );
      assert.deepEqual(historicalQuestion.rows, [
        {
          id: oldVersionId,
          prompt: currentPrompt,
          reference_answer: "Obsolete mutable answer",
          lifecycle: "archived",
          target_key: currentPromptKey,
        },
      ]);
      const duplicateCandidates = await client.query<{
        id: string;
        lifecycle: string;
      }>(
        `SELECT id, lifecycle::text
           FROM ${schemaName}.questions
          WHERE user_id = $1 AND target_key = $2
          ORDER BY lifecycle = 'active' DESC, id`,
        [learnerId, currentPromptKey],
      );
      assert.deepEqual(duplicateCandidates.rows, [
        { id: questionId, lifecycle: "active" },
        { id: oldVersionId, lifecycle: "archived" },
      ]);
      await client.query("BEGIN");
      await assert.rejects(
        client.query(
          `UPDATE ${schemaName}.questions SET lifecycle = 'active'
            WHERE user_id = $1 AND id = $2`,
          [learnerId, oldVersionId],
        ),
        /questions_active_target_unique/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        client.query(
          `INSERT INTO ${schemaName}.questions
             (user_id, prompt, reference_answer, lifecycle, target_key)
           VALUES ($1, $2, 'Duplicate answer', 'active', $3)`,
          [learnerId, currentPrompt, currentPromptKey],
        ),
        /questions_active_target_unique/u,
      );
      await client.query("ROLLBACK");
      const mappedLifecycles = await client.query<{
        id: string;
        lifecycle: string;
      }>(
        `SELECT id, lifecycle::text FROM ${schemaName}.questions
          WHERE id = ANY($1::uuid[]) ORDER BY lifecycle`,
        [[flaggedQuestionId, archivedQuestionId]],
      );
      assert.deepEqual(
        new Map(mappedLifecycles.rows.map((row) => [row.id, row.lifecycle])),
        new Map([
          [flaggedQuestionId, "flagged"],
          [archivedQuestionId, "archived"],
        ]),
      );

      const retainedEvidence = await client.query<{
        submission_id: string;
        submission_question_id: string;
        evaluation_id: string;
        evaluation_question_id: string;
        grade_event_id: string;
        grade_question_id: string;
      }>(
        `SELECT submission.id AS submission_id,
                submission.question_id AS submission_question_id,
                evaluation.id AS evaluation_id,
                evaluation.question_id AS evaluation_question_id,
                event.id AS grade_event_id,
                event.question_id AS grade_question_id
           FROM ${schemaName}.answer_submissions submission
           JOIN ${schemaName}.evaluations evaluation
             ON evaluation.user_id = submission.user_id
            AND evaluation.submission_id = submission.id
           JOIN ${schemaName}.grade_events event
             ON event.user_id = submission.user_id
            AND event.submission_id = submission.id
          WHERE submission.id = ANY($1::uuid[])
          ORDER BY submission.submitted_at`,
        [[oldSubmissionId, currentSubmissionId]],
      );
      assert.deepEqual(retainedEvidence.rows, [
        {
          submission_id: oldSubmissionId,
          submission_question_id: oldVersionId,
          evaluation_id: oldEvaluationId,
          evaluation_question_id: oldVersionId,
          grade_event_id: oldGradeEventId,
          grade_question_id: oldVersionId,
        },
        {
          submission_id: currentSubmissionId,
          submission_question_id: questionId,
          evaluation_id: currentEvaluationId,
          evaluation_question_id: questionId,
          grade_event_id: currentGradeEventId,
          grade_question_id: questionId,
        },
      ]);
      await client.query("BEGIN");
      await assert.rejects(
        client.query(
          `INSERT INTO ${schemaName}.evaluations
             (user_id, question_id, submission_id, evaluator)
           VALUES ($1, $2, $3, 'model')`,
          [learnerId, singleQuestionId, currentSubmissionId],
        ),
        /evaluations_submission_question_fk/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        client.query(
          `INSERT INTO ${schemaName}.grade_events
             (user_id, question_id, submission_id, grade, origin)
           VALUES ($1, $2, $3, 'good', 'model')`,
          [learnerId, singleQuestionId, currentSubmissionId],
        ),
        /grade_events_submission_question_fk/u,
      );
      await client.query("ROLLBACK");

      const retainedMemory = await client.query<{
        question_id: string;
        due_on: string;
      }>(
        `SELECT question_id, due_on::text
           FROM ${schemaName}.memory_states
          WHERE user_id = $1
          ORDER BY question_id`,
        [learnerId],
      );
      assert.deepEqual(retainedMemory.rows, [
        { question_id: singleQuestionId, due_on: "2030-08-26" },
      ]);

      const retainedSearch = await client.query<{
        question_id: string;
        source_hash: string;
      }>(
        `SELECT question_id, source_hash
           FROM ${schemaName}.question_search_embeddings
          WHERE user_id = $1
          ORDER BY source_version`,
        [learnerId],
      );
      assert.deepEqual(retainedSearch.rows, [
        { question_id: questionId, source_hash: "current-retained-hash" },
        { question_id: oldVersionId, source_hash: "historical-retained-hash" },
      ]);

      const retainedReceipt = await client.query<{ response: unknown }>(
        `SELECT response FROM ${schemaName}.mutation_receipts
          WHERE user_id = $1 AND scope = 'library-add-questions'
            AND key = 'legacy-add'`,
        [learnerId],
      );
      assert.deepEqual(retainedReceipt.rows, [
        {
          response: {
            results: [
              {
                id: questionId,
                prompt: currentPrompt,
                referenceAnswer: currentAnswer,
                lifecycle: "active",
                outcome: "inserted",
                flags: [],
                answerStandardConflict: false,
              },
            ],
          },
        },
      ]);

      const catalog = await client.query<{
        question_versions: null;
        answer_mode: null;
        lifecycle_values: string[];
        submission_has_version: boolean;
        embedding_has_version: boolean;
        question_version_columns: string[];
        obsolete_constraints: string[];
        obsolete_indexes: string[];
        evidence_integrity_constraints: string[];
        evaluation_has_question: boolean;
        grade_event_has_question: boolean;
      }>(
        `SELECT
           to_regclass('${schemaName}.question_versions') AS question_versions,
           to_regtype('${schemaName}.answer_mode') AS answer_mode,
           ARRAY(
             SELECT enum.enumlabel::text
               FROM pg_type type
               JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
               JOIN pg_enum enum ON enum.enumtypid = type.oid
              WHERE namespace.nspname = $1
                AND type.typname = 'question_lifecycle'
              ORDER BY enum.enumsortorder
           ) AS lifecycle_values,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'answer_submissions'
                AND column_name = 'question_version_id'
           ) AS submission_has_version,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = $1
                AND table_name = 'question_search_embeddings'
                AND column_name = 'question_version_id'
           ) AS embedding_has_version,
           ARRAY(
             SELECT table_name || '.' || column_name
               FROM information_schema.columns
              WHERE table_schema = $1
                AND column_name = 'question_version_id'
              ORDER BY table_name
           )::text[] AS question_version_columns,
           ARRAY(
             SELECT constraint_name
               FROM information_schema.table_constraints
              WHERE constraint_schema = $1
                AND constraint_name IN (
                  'answer_submissions_version_fk',
                  'question_search_embeddings_version_fk',
                  'question_embeddings_version_fk',
                  'question_evidence_version_fk',
                  'question_versions_question_fk'
                )
              ORDER BY constraint_name
           )::text[] AS obsolete_constraints,
           ARRAY(
             SELECT indexname
               FROM pg_indexes
              WHERE schemaname = $1
                AND indexname LIKE 'question_versions_%'
              ORDER BY indexname
           )::text[] AS obsolete_indexes,
           ARRAY(
             SELECT constraint_name
               FROM information_schema.table_constraints
              WHERE constraint_schema = $1
                AND constraint_name IN (
                  'answer_submissions_user_id_id_question_id_unique',
                  'evaluations_submission_question_fk',
                  'grade_events_submission_question_fk'
                )
              ORDER BY constraint_name
           )::text[] AS evidence_integrity_constraints,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'evaluations'
                AND column_name = 'question_id' AND is_nullable = 'NO'
           ) AS evaluation_has_question,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'grade_events'
                AND column_name = 'question_id' AND is_nullable = 'NO'
           ) AS grade_event_has_question`,
        [schemaName],
      );
      assert.deepEqual(catalog.rows, [
        {
          question_versions: null,
          answer_mode: null,
          lifecycle_values: ["active", "flagged", "archived"],
          submission_has_version: false,
          embedding_has_version: false,
          question_version_columns: [],
          obsolete_constraints: [],
          obsolete_indexes: [],
          evidence_integrity_constraints: [
            "answer_submissions_user_id_id_question_id_unique",
            "evaluations_submission_question_fk",
            "grade_events_submission_question_fk",
          ],
          evaluation_has_question: true,
          grade_event_has_question: true,
        },
      ]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
