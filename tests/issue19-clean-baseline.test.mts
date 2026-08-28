import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

const testDatabaseUrl = process.env.APPLICATION_CONTRACT_TEST_DATABASE_URL;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

const expectedTables = [
  "answer_submissions",
  "evaluations",
  "grade_events",
  "jobs",
  "learner_settings",
  "llm_trace_interactions",
  "mcp_credentials",
  "memory_states",
  "mutation_receipts",
  "question_flags",
  "question_search_embeddings",
  "questions",
  "recall_result_corrections",
  "users",
];

const expectedEnums = [
  "evaluation_status",
  "grade",
  "grade_origin",
  "job_status",
  "question_flag_origin",
  "question_lifecycle",
  "recall_result",
  "submission_status",
];

const expectedEnumValues = {
  evaluation_status: ["pending", "complete", "failed", "superseded"],
  grade: ["again", "hard", "good", "easy"],
  grade_origin: [
    "deterministic",
    "model",
    "self",
    "correction",
    "invalidated",
  ],
  job_status: ["pending", "running", "succeeded", "failed", "cancelled"],
  question_flag_origin: ["waxon_validation", "learner"],
  question_lifecycle: ["active", "flagged", "archived"],
  recall_result: ["incorrect", "partial", "correct"],
  submission_status: ["pending", "graded", "invalidated"],
};

const expectedColumns: Record<string, string[]> = {
  answer_submissions: [
    "id", "user_id", "question_id", "answer", "status", "submitted_at", "created_at",
  ],
  evaluations: [
    "id", "user_id", "question_id", "submission_id", "status", "evaluator",
    "proposed_grade", "feedback", "expected_answer", "covered_points",
    "missing_points", "demonstrated_gap", "confidence", "error", "created_at",
    "completed_at", "proposed_recall_result", "scoring_issues", "clarifications",
  ],
  grade_events: [
    "id", "user_id", "question_id", "submission_id", "grade", "origin",
    "evaluation_id", "created_at", "derivation_version",
  ],
  jobs: [
    "id", "user_id", "type", "idempotency_key", "status", "priority", "payload",
    "result", "progress", "attempts", "run_after", "locked_until", "error",
    "created_at", "updated_at",
  ],
  learner_settings: [
    "user_id", "timezone", "auto_accept_high_confidence", "created_at", "updated_at",
  ],
  llm_trace_interactions: [
    "id", "title", "kind", "started_at", "status", "calls", "updated_at",
  ],
  mcp_credentials: [
    "user_id", "token_hash", "token_prefix", "created_at", "last_used_at", "revoked_at",
  ],
  memory_states: [
    "user_id", "question_id", "due_at", "due_on", "last_review_at", "stability",
    "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses", "state",
    "learning_steps", "scheduler_version", "updated_at",
  ],
  mutation_receipts: [
    "user_id", "scope", "key", "request_hash", "response", "created_at",
  ],
  question_flags: [
    "id", "user_id", "question_id", "origin", "reasons", "detail", "created_at",
    "resolved_at",
  ],
  question_search_embeddings: [
    "user_id", "question_id", "model", "embedding_version", "prompt_hash", "embedding",
    "created_at", "updated_at",
  ],
  questions: [
    "id", "user_id", "prompt", "reference_answer", "lifecycle", "target_key",
    "creation_order", "created_at", "updated_at",
  ],
  recall_result_corrections: [
    "id", "user_id", "question_id", "submission_id", "recall_result", "created_at",
  ],
  users: [
    "id", "display_name", "email", "avatar_url", "created_at", "updated_at",
  ],
};

const expectedNullableColumns: Record<string, string[]> = {
  answer_submissions: [],
  evaluations: [
    "proposed_grade", "feedback", "expected_answer", "demonstrated_gap", "confidence",
    "error", "completed_at", "proposed_recall_result",
  ],
  grade_events: ["evaluation_id", "derivation_version"],
  jobs: ["result", "locked_until", "error"],
  learner_settings: ["timezone"],
  llm_trace_interactions: [],
  mcp_credentials: ["last_used_at", "revoked_at"],
  memory_states: ["last_review_at"],
  mutation_receipts: [],
  question_flags: ["detail", "resolved_at"],
  question_search_embeddings: [],
  questions: [],
  recall_result_corrections: [],
  users: ["avatar_url"],
};

const expectedDefaults: Record<string, string> = {
  "answer_submissions.created_at": "now()",
  "answer_submissions.id": "gen_random_uuid()",
  "answer_submissions.status": "'pending'::waxon_v2.submission_status",
  "evaluations.covered_points": "'[]'::jsonb",
  "evaluations.created_at": "now()",
  "evaluations.id": "gen_random_uuid()",
  "evaluations.missing_points": "'[]'::jsonb",
  "evaluations.scoring_issues": "'[]'::jsonb",
  "evaluations.clarifications": "'[]'::jsonb",
  "evaluations.status": "'pending'::waxon_v2.evaluation_status",
  "grade_events.created_at": "now()",
  "grade_events.id": "gen_random_uuid()",
  "jobs.attempts": "0",
  "jobs.created_at": "now()",
  "jobs.id": "gen_random_uuid()",
  "jobs.payload": "'{}'::jsonb",
  "jobs.priority": "2",
  "jobs.progress": "0",
  "jobs.run_after": "now()",
  "jobs.status": "'pending'::waxon_v2.job_status",
  "jobs.updated_at": "now()",
  "learner_settings.auto_accept_high_confidence": "true",
  "learner_settings.created_at": "now()",
  "learner_settings.updated_at": "now()",
  "mcp_credentials.created_at": "now()",
  "memory_states.difficulty": "0",
  "memory_states.elapsed_days": "0",
  "memory_states.lapses": "0",
  "memory_states.learning_steps": "0",
  "memory_states.reps": "0",
  "memory_states.scheduled_days": "0",
  "memory_states.scheduler_version": "'fsrs-6'::text",
  "memory_states.stability": "0",
  "memory_states.state": "0",
  "memory_states.updated_at": "now()",
  "mutation_receipts.created_at": "now()",
  "question_flags.created_at": "now()",
  "question_flags.id": "gen_random_uuid()",
  "question_flags.reasons": "'[]'::jsonb",
  "recall_result_corrections.created_at": "now()",
  "recall_result_corrections.id": "gen_random_uuid()",
  "question_search_embeddings.created_at": "now()",
  "question_search_embeddings.updated_at": "now()",
  "questions.created_at": "now()",
  "questions.creation_order":
    "nextval('waxon_v2.questions_creation_order_seq'::regclass)",
  "questions.id": "gen_random_uuid()",
  "questions.lifecycle": "'active'::waxon_v2.question_lifecycle",
  "questions.updated_at": "now()",
  "users.created_at": "now()",
  "users.updated_at": "now()",
};

const expectedConstraintDefinitions: Record<string, string> = {
  answer_submissions_pkey: "PRIMARY KEY (id)",
  answer_submissions_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE RESTRICT",
  answer_submissions_user_id_id_unique: "UNIQUE (user_id, id)",
  answer_submissions_user_id_id_question_id_unique:
    "UNIQUE (user_id, id, question_id)",
  evaluations_pkey: "PRIMARY KEY (id)",
  evaluations_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE RESTRICT",
  evaluations_submission_question_fk:
    "FOREIGN KEY (user_id, submission_id, question_id) REFERENCES waxon_v2.answer_submissions(user_id, id, question_id) ON DELETE CASCADE",
  evaluations_user_id_id_unique: "UNIQUE (user_id, id)",
  grade_events_pkey: "PRIMARY KEY (id)",
  grade_events_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE RESTRICT",
  grade_events_submission_question_fk:
    "FOREIGN KEY (user_id, submission_id, question_id) REFERENCES waxon_v2.answer_submissions(user_id, id, question_id) ON DELETE CASCADE",
  grade_events_user_id_id_unique: "UNIQUE (user_id, id)",
  jobs_pkey: "PRIMARY KEY (id)",
  jobs_user_id_users_id_fk:
    "FOREIGN KEY (user_id) REFERENCES waxon_v2.users(id) ON DELETE CASCADE",
  jobs_user_idempotency_unique: "UNIQUE (user_id, type, idempotency_key)",
  learner_settings_pkey: "PRIMARY KEY (user_id)",
  learner_settings_user_id_users_id_fk:
    "FOREIGN KEY (user_id) REFERENCES waxon_v2.users(id) ON DELETE CASCADE",
  llm_trace_interactions_pkey: "PRIMARY KEY (id)",
  mcp_credentials_pkey: "PRIMARY KEY (user_id)",
  mcp_credentials_token_hash_unique: "UNIQUE (token_hash)",
  mcp_credentials_user_id_users_id_fk:
    "FOREIGN KEY (user_id) REFERENCES waxon_v2.users(id) ON DELETE CASCADE",
  memory_states_pk: "PRIMARY KEY (user_id, question_id)",
  memory_states_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE CASCADE",
  mutation_receipts_pk: "PRIMARY KEY (user_id, scope, key)",
  mutation_receipts_user_id_users_id_fk:
    "FOREIGN KEY (user_id) REFERENCES waxon_v2.users(id) ON DELETE CASCADE",
  question_flags_pkey: "PRIMARY KEY (id)",
  question_flags_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE CASCADE",
  question_search_embeddings_pk:
    "PRIMARY KEY (user_id, question_id, model, embedding_version)",
  question_search_embeddings_question_fk:
    "FOREIGN KEY (user_id, question_id) REFERENCES waxon_v2.questions(user_id, id) ON DELETE CASCADE",
  questions_pkey: "PRIMARY KEY (id)",
  questions_user_id_id_unique: "UNIQUE (user_id, id)",
  questions_user_id_users_id_fk:
    "FOREIGN KEY (user_id) REFERENCES waxon_v2.users(id) ON DELETE CASCADE",
  users_id_nonempty: "CHECK ((length(TRIM(BOTH FROM id)) > 0))",
  users_pkey: "PRIMARY KEY (id)",
};

const expectedIndexFragments: Record<string, string[]> = {
  answer_submissions_pending_question_idx: ["(user_id, question_id, status)"],
  evaluations_submission_idx: ["(user_id, submission_id)"],
  grade_events_submission_created_idx: ["(user_id, submission_id, created_at)"],
  jobs_claim_idx: ["(status, priority, run_after, created_at)"],
  question_flags_question_created_idx: [
    "(user_id, question_id, created_at)",
  ],
  mcp_credentials_active_token_idx: ["(token_hash)", "WHERE (revoked_at IS NULL)"],
  memory_states_due_idx: ["(user_id, due_on)"],
  question_flags_unresolved_idx: [
    "(user_id, question_id)",
    "WHERE (resolved_at IS NULL)",
  ],
  question_search_embeddings_lookup_idx: [
    "(user_id, model, embedding_version)",
  ],
  questions_active_target_unique: [
    "CREATE UNIQUE INDEX",
    "(user_id, target_key)",
    "WHERE (lifecycle = 'active'",
  ],
  questions_prompt_trgm_idx: ["USING gist", "prompt gist_trgm_ops"],
  questions_search_idx: ["USING gin", "to_tsvector", "reference_answer"],
  questions_user_lifecycle_idx: ["(user_id, lifecycle)"],
  questions_user_target_idx: ["(user_id, target_key)"],
  users_email_idx: ["(email)"],
  v2_llm_trace_interactions_started_at_idx: [
    "(started_at DESC NULLS LAST)",
  ],
};

const retiredIdentifiers = [
  "answer_mode",
  "concept_aliases",
  "concepts",
  "coverage_status",
  "coverage_targets",
  "data_migration_markers",
  "evidence_spans",
  "generation_run_artifacts",
  "generation_runs",
  "question_concepts",
  "question_embeddings",
  "question_evidence",
  "question_relations",
  "question_versions",
  "source_focus_stack",
  "source_kind",
  "source_learning_edges",
  "source_learning_nodes",
  "source_learning_paths",
  "source_material_kind",
  "source_materials",
  "source_status",
  "source_versions",
  "sources",
  "target_evidence",
  "target_questions",
  "usage_counters",
];

const retiredPublicTables = [
  "answer_evaluations",
  "auth_accounts",
  "concept_tags",
  "course_chat_messages",
  "course_page_attempts",
  "course_pages",
  "courses",
  "decks",
  "llm_trace_interactions",
  "question_attempts",
  "question_concept_tags",
  "question_embeddings",
  "question_reviews",
  "questions",
  "questions_trash",
  "users",
];

async function applySql(client: PoolClient, source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

function runDatabaseCommand(
  args: string[],
  databaseUrl: string,
): ReturnType<typeof spawnSync> {
  return spawnSync("pnpm", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
    },
  });
}

function assertCommandSucceeded(
  result: ReturnType<typeof spawnSync>,
  label: string,
): void {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("issue #19 removes retired route and source-migration compatibility surfaces", async () => {
  const nextConfig = await readFile(
    new URL("../next.config.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(nextConfig, /source:\s*["']\/(?:queue|tags)["']/u);

  for (const route of ["queue", "tags"]) {
    await assert.rejects(
      access(new URL(`../app/${route}`, import.meta.url)),
      { code: "ENOENT" },
      `retired /${route} must not remain as a filesystem route`,
    );
    await assert.rejects(
      access(new URL(`../app/(app)/${route}`, import.meta.url)),
      { code: "ENOENT" },
      `retired /${route} must not remain as an authenticated route`,
    );
  }

  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["clerk:migrate-users"], undefined);
  await assert.rejects(
    access(new URL("../scripts/migrate-clerk-users.mjs", import.meta.url)),
    { code: "ENOENT" },
    "the source-database Clerk migration must not remain executable",
  );
});

test(
  "issue #19 creates the accepted catalog from the clean baseline and ordinary migrations",
  { skip: testDatabaseUrl ? false : "APPLICATION_CONTRACT_TEST_DATABASE_URL is not set" },
  async () => {
    if (!testDatabaseUrl) return;
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle-v2/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as MigrationJournal;

    assert.deepEqual(
      journal.entries.map(({ idx }) => idx),
      [0, 1],
      "the migration history must start at the clean baseline and remain sequential",
    );

    const entry = journal.entries[0];
    assert.ok(entry);
    const baseline = await readFile(
      new URL(`../drizzle-v2/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    const migrations = await Promise.all(
      journal.entries.map((migration) =>
        readFile(
          new URL(`../drizzle-v2/${migration.tag}.sql`, import.meta.url),
          "utf8",
        )
      ),
    );
    assert.doesNotMatch(
      baseline,
      /^[ \t]*(?:drop|delete|update|insert|truncate)\b/imu,
      "a fresh baseline must create the accepted model without cleanup DDL or data rewrites",
    );
    for (const identifier of retiredIdentifiers) {
      assert.equal(
        baseline.includes(`\"${identifier}\"`),
        false,
        `baseline must not mention retired identifier ${identifier}`,
      );
    }

    const pool = new Pool({ connectionString: testDatabaseUrl });
    const client = await pool.connect();
    const schemaName = `waxon_issue19_${randomUUID().replaceAll("-", "")}`;

    try {
      for (const migration of migrations) {
        await applySql(client, migration.replaceAll("waxon_v2", schemaName));
      }

      const tables = await client.query<{ name: string }>(
        `SELECT table_name AS name
           FROM information_schema.tables
          WHERE table_schema = $1
          ORDER BY table_name`,
        [schemaName],
      );
      assert.deepEqual(
        tables.rows.map(({ name }) => name),
        expectedTables,
      );

      const enums = await client.query<{ name: string }>(
        `SELECT type.typname AS name,
                array_agg(value.enumlabel::text ORDER BY value.enumsortorder) AS values
           FROM pg_type type
           JOIN pg_enum value ON value.enumtypid = type.oid
           JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE namespace.nspname = $1
            AND type.typtype = 'e'
          GROUP BY type.typname
          ORDER BY type.typname`,
        [schemaName],
      );
      assert.deepEqual(
        enums.rows.map(({ name }) => name),
        expectedEnums,
      );
      assert.deepEqual(
        Object.fromEntries(
          (
            enums.rows as Array<{ name: string; values: string[] }>
          ).map(({ name, values }) => [name, values]),
        ),
        expectedEnumValues,
      );

      const columns = await client.query<{
        tableName: string;
        name: string;
        nullable: "YES" | "NO";
        defaultValue: string | null;
      }>(
        `SELECT table_name AS "tableName",
                column_name AS name,
                is_nullable AS nullable,
                column_default AS "defaultValue"
           FROM information_schema.columns
          WHERE table_schema = $1
          ORDER BY table_name, ordinal_position`,
        [schemaName],
      );
      const catalogColumns: Record<string, string[]> = {};
      const nullableColumns: Record<string, string[]> = {};
      const defaults: Record<string, string> = {};
      for (const column of columns.rows) {
        (catalogColumns[column.tableName] ??= []).push(column.name);
        nullableColumns[column.tableName] ??= [];
        if (column.nullable === "YES") {
          nullableColumns[column.tableName]?.push(column.name);
        }
        if (column.defaultValue !== null) {
          defaults[`${column.tableName}.${column.name}`] =
            column.defaultValue.replaceAll(schemaName, "waxon_v2");
        }
      }
      assert.deepEqual(catalogColumns, expectedColumns);
      assert.deepEqual(nullableColumns, expectedNullableColumns);
      assert.deepEqual(defaults, expectedDefaults);

      const constraints = await client.query<{
        name: string;
        definition: string;
      }>(
        `SELECT catalog_constraint.conname AS name,
                pg_get_constraintdef(catalog_constraint.oid) AS definition
           FROM pg_constraint catalog_constraint
           JOIN pg_namespace namespace
             ON namespace.oid = catalog_constraint.connamespace
          WHERE namespace.nspname = $1`,
        [schemaName],
      );
      const constraintDefinitions = new Map(
        constraints.rows.map(({ name, definition }) => [
          name,
          definition.replaceAll(schemaName, "waxon_v2"),
        ]),
      );
      for (const [name, definition] of Object.entries(
        expectedConstraintDefinitions,
      )) {
        assert.equal(
          constraintDefinitions.get(name),
          definition,
          `retained constraint ${name} must preserve its contract`,
        );
      }

      const indexes = await client.query<{ name: string; definition: string }>(
        `SELECT indexname AS name, indexdef AS definition
           FROM pg_indexes
          WHERE schemaname = $1`,
        [schemaName],
      );
      const indexDefinitions = new Map(
        indexes.rows.map(({ name, definition }) => [name, definition]),
      );
      for (const [name, fragments] of Object.entries(expectedIndexFragments)) {
        const definition = indexDefinitions.get(name);
        assert.ok(definition, `retained index ${name} must exist`);
        for (const fragment of fragments) {
          assert.ok(
            definition.includes(fragment),
            `retained index ${name} must include ${fragment}`,
          );
        }
      }

      const searchColumns = await client.query<{ name: string }>(
        `SELECT column_name AS name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'question_search_embeddings'
          ORDER BY ordinal_position`,
        [schemaName],
      );
      assert.deepEqual(
        searchColumns.rows.map(({ name }) => name),
        [
          "user_id",
          "question_id",
          "model",
          "embedding_version",
          "prompt_hash",
          "embedding",
          "created_at",
          "updated_at",
        ],
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS \"${schemaName}\" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);

test(
  "issue #19 clean break is explicit, complete, repeatable, and leaves ordinary migrations safe",
  { skip: testDatabaseUrl ? false : "APPLICATION_CONTRACT_TEST_DATABASE_URL is not set" },
  async () => {
    if (!testDatabaseUrl) return;
    const pool = new Pool({ connectionString: testDatabaseUrl });

    try {
      for (const table of retiredPublicTables) {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS "public"."${table}" (id integer PRIMARY KEY)`,
        );
      }
      await pool.query(
        "CREATE TABLE IF NOT EXISTS public.issue19_unrelated_probe (id integer PRIMARY KEY)",
      );
      await pool.query(
        'CREATE TABLE IF NOT EXISTS waxon_v2.legacy_cutover_probe (id integer PRIMARY KEY)',
      );
      await pool.query(
        `CREATE OR REPLACE VIEW waxon_v2.legacy_cutover_view AS
         SELECT id FROM waxon_v2.legacy_cutover_probe`,
      );
      await pool.query(
        `CREATE OR REPLACE FUNCTION waxon_v2.legacy_cutover_routine()
         RETURNS integer LANGUAGE sql AS 'SELECT 19'`,
      );
      await pool.query(
        "INSERT INTO public.users (id) VALUES (19) ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "INSERT INTO waxon_v2.legacy_cutover_probe (id) VALUES (19) ON CONFLICT DO NOTHING",
      );
      await pool.query(
        "DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'legacy-cutover-probe'",
      );
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ('legacy-cutover-probe', 1)`,
      );

      const refused = runDatabaseCommand(["db:reset"], testDatabaseUrl);
      assert.equal(refused.status, 2);
      assert.match(
        `${refused.stdout}${refused.stderr}`,
        /--confirm-clean-break/,
      );
      assert.equal(
        (
          await pool.query<{ name: string | null }>(
            "SELECT to_regclass('waxon_v2.legacy_cutover_probe')::text AS name",
          )
        ).rows[0]?.name,
        "waxon_v2.legacy_cutover_probe",
        "refusal must not mutate the database",
      );
      assert.deepEqual(
        (
          await pool.query<{ name: string }>(
            `SELECT table_name AS name
               FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name = ANY($1::text[])
              ORDER BY table_name`,
            [retiredPublicTables],
          )
        ).rows.map(({ name }) => name),
        retiredPublicTables,
        "refusal must retain every retired public Waxon table",
      );
      await pool.query(
        "CREATE OR REPLACE VIEW public.issue19_unrelated_dependency AS SELECT id FROM public.users",
      );
      const blockedReset = runDatabaseCommand(
        ["db:reset", "--", "--confirm-clean-break"],
        testDatabaseUrl,
      );
      assert.notEqual(
        blockedReset.status,
        0,
        "an unrelated dependency must block the clean break",
      );
      assert.equal(
        (
          await pool.query<{ name: string | null }>(
            "SELECT to_regclass('waxon_v2.legacy_cutover_probe')::text AS name",
          )
        ).rows[0]?.name,
        "waxon_v2.legacy_cutover_probe",
        "a blocked clean break must roll back every destructive step",
      );
      assert.equal(
        (
          await pool.query<{ name: string | null }>(
            "SELECT to_regclass('public.issue19_unrelated_dependency')::text AS name",
          )
        ).rows[0]?.name,
        "issue19_unrelated_dependency",
      );
      await pool.query("DROP VIEW public.issue19_unrelated_dependency");

      await pool.query(
        `CREATE VIEW public.issue19_waxon_dependency AS
         SELECT id FROM waxon_v2.legacy_cutover_probe`,
      );
      const schemaBlockedReset = runDatabaseCommand(
        ["db:reset", "--", "--confirm-clean-break"],
        testDatabaseUrl,
      );
      assert.notEqual(
        schemaBlockedReset.status,
        0,
        "a cross-schema dependency must block the clean break",
      );
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM waxon_v2.legacy_cutover_probe WHERE id = 19",
          )
        ).rows[0]?.count,
        "1",
        "a cross-schema dependency must leave old application data intact",
      );
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.users WHERE id = 19",
          )
        ).rows[0]?.count,
        "1",
        "a cross-schema dependency must roll back retired public-table drops",
      );
      assert.deepEqual(
        (
          await pool.query<{ hash: string; createdAt: string }>(
            `SELECT hash, created_at::text AS "createdAt"
               FROM drizzle.__drizzle_migrations
              ORDER BY created_at`,
          )
        ).rows,
        [
          { hash: "legacy-cutover-probe", createdAt: "1" },
          {
            hash: "3cce11497894f07624fc4a358471687b3754453757d5433501f966c7ea574494",
            createdAt: "1787774146240",
          },
          {
            hash: "6143ce68278638ad8bfd8e27a86bed2d65b3d0c2aa0b45e9ebfe11c6ee54a09b",
            createdAt: "1787936466888",
          },
        ],
        "a cross-schema dependency must preserve old migration metadata",
      );
      await pool.query("DROP VIEW public.issue19_waxon_dependency");

      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle-v2/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ) as MigrationJournal;
      const entry = journal.entries[0];
      assert.ok(entry);
      const baseline = await readFile(
        new URL(`../drizzle-v2/${entry.tag}.sql`, import.meta.url),
        "utf8",
      );
      const { replaceWithCleanBaseline } = await import(
        "../scripts/lib/clean-break.mjs"
      );
      await assert.rejects(
        replaceWithCleanBaseline({
          connectionString: testDatabaseUrl,
          baselineSql: `${baseline}\n--> statement-breakpoint\nSELECT * FROM issue19_forced_baseline_failure`,
          migrationTimestamp: entry.when,
        }),
        /issue19_forced_baseline_failure/u,
      );
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM waxon_v2.legacy_cutover_probe WHERE id = 19",
          )
        ).rows[0]?.count,
        "1",
        "a baseline installation failure must restore old application data",
      );
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.users WHERE id = 19",
          )
        ).rows[0]?.count,
        "1",
        "a baseline installation failure must restore retired public data",
      );
      assert.deepEqual(
        (
          await pool.query<{ viewExists: boolean; routineExists: boolean }>(
            `SELECT
               to_regclass('waxon_v2.legacy_cutover_view') IS NOT NULL AS "viewExists",
               to_regprocedure('waxon_v2.legacy_cutover_routine()') IS NOT NULL AS "routineExists"`,
          )
        ).rows,
        [{ viewExists: true, routineExists: true }],
        "a baseline installation failure must restore old schema objects",
      );
      assert.deepEqual(
        (
          await pool.query<{ hash: string; createdAt: string }>(
            `SELECT hash, created_at::text AS "createdAt"
               FROM drizzle.__drizzle_migrations
              ORDER BY created_at`,
          )
        ).rows,
        [
          { hash: "legacy-cutover-probe", createdAt: "1" },
          {
            hash: "3cce11497894f07624fc4a358471687b3754453757d5433501f966c7ea574494",
            createdAt: "1787774146240",
          },
          {
            hash: "6143ce68278638ad8bfd8e27a86bed2d65b3d0c2aa0b45e9ebfe11c6ee54a09b",
            createdAt: "1787936466888",
          },
        ],
        "a baseline installation failure must restore old migration metadata",
      );

      const reset = runDatabaseCommand(
        ["db:reset", "--", "--confirm-clean-break"],
        testDatabaseUrl,
      );
      assertCommandSucceeded(reset, "confirmed clean break");

      const tables = await pool.query<{ name: string }>(
        `SELECT table_name AS name
           FROM information_schema.tables
          WHERE table_schema = 'waxon_v2'
          ORDER BY table_name`,
      );
      assert.deepEqual(
        tables.rows.map(({ name }) => name),
        expectedTables,
      );
      const migrations = await pool.query<{ hash: string; createdAt: string }>(
        `SELECT hash, created_at::text AS "createdAt"
           FROM drizzle.__drizzle_migrations
          ORDER BY created_at`,
      );
      assert.deepEqual(migrations.rows, [
        {
          hash: "3cce11497894f07624fc4a358471687b3754453757d5433501f966c7ea574494",
          createdAt: "1787774146240",
        },
        {
          hash: "6143ce68278638ad8bfd8e27a86bed2d65b3d0c2aa0b45e9ebfe11c6ee54a09b",
          createdAt: "1787936466888",
        },
      ]);
      assert.deepEqual(
        (
          await pool.query<{ name: string }>(
            `SELECT table_name AS name
               FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name = ANY($1::text[])
              ORDER BY table_name`,
            [retiredPublicTables],
          )
        ).rows,
        [],
        "the clean break must remove every retired public Waxon table",
      );
      assert.equal(
        (
          await pool.query<{ name: string | null }>(
            "SELECT to_regclass('public.issue19_unrelated_probe')::text AS name",
          )
        ).rows[0]?.name,
        "issue19_unrelated_probe",
        "the clean break must preserve unrelated public objects",
      );

      const repeatedReset = spawnSync(
        process.execPath,
        ["scripts/reset-v2.mjs", "--confirm-clean-break"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: testDatabaseUrl,
            DATABASE_URL_UNPOOLED: testDatabaseUrl,
            PATH: "",
          },
        },
      );
      assertCommandSucceeded(repeatedReset, "repeated clean break");

      const ordinaryMigration = runDatabaseCommand(
        ["db:migrate"],
        testDatabaseUrl,
      );
      assertCommandSucceeded(
        ordinaryMigration,
        "ordinary migration after the clean break",
      );
      assert.deepEqual(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
          )
        ).rows,
        [{ count: "2" }],
      );
    } finally {
      await pool.query(
        "DROP VIEW IF EXISTS public.issue19_unrelated_dependency",
      );
      await pool.query("DROP VIEW IF EXISTS public.issue19_waxon_dependency");
      await pool.query("DROP TABLE IF EXISTS public.issue19_unrelated_probe");
      await pool.end();
    }
  },
);
