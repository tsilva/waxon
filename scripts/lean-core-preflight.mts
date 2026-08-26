import { Pool } from "pg";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and keyenv can provide the connection without local files.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const retainedTables = [
  "users",
  "learner_settings",
  "questions",
  "question_versions",
  "question_search_embeddings",
  "answer_submissions",
  "evaluations",
  "grade_events",
  "memory_states",
  "jobs",
  "mutation_receipts",
  "usage_counters",
] as const;
const retiredTables = [
  "review_sessions",
  "review_session_items",
  "retry_obligations",
  "sources",
  "source_versions",
  "source_materials",
  "generation_runs",
  "generation_run_artifacts",
  "evidence_spans",
  "coverage_targets",
  "target_evidence",
  "question_evidence",
  "target_questions",
  "source_learning_paths",
  "source_learning_nodes",
  "source_learning_edges",
  "source_focus_stack",
  "review_session_item_path_nodes",
  "concepts",
  "concept_aliases",
  "question_concepts",
  "question_relations",
  "question_embeddings",
  "repair_drafts",
] as const;

async function counts(tables: readonly string[]) {
  const result: Record<string, number | null> = {};
  for (const table of tables) {
    const exists = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [`waxon_v2.${table}`],
    );
    if (!exists.rows[0]?.exists) {
      result[table] = null;
      continue;
    }
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waxon_v2.${table}`,
    );
    result[table] = Number(count.rows[0]?.count ?? 0);
  }
  return result;
}

try {
  const blobs = await pool.query<{
    sourceId: string;
    userId: string;
    objectUrl: string;
    byteSize: string;
  }>(
    `SELECT id::text AS "sourceId", user_id AS "userId",
            object_url AS "objectUrl", byte_size::text AS "byteSize"
       FROM waxon_v2.sources
      WHERE object_url IS NOT NULL
      ORDER BY user_id, id`,
  );
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        retained: await counts(retainedTables),
        retired: await counts(retiredTables),
        blobInventory: blobs.rows,
        blobBytes: blobs.rows.reduce(
          (sum, row) => sum + Number(row.byteSize || 0),
          0,
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
