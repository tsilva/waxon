import { Pool } from "pg";
import {
  QUESTION_SEARCH_SOURCE_VERSION,
  questionSearchSourceHash,
  questionSearchVectorLiteral,
  requestQuestionSearchEmbeddings,
  resolveQuestionSearchConfig,
} from "../shared/question-search.mts";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and keyenv can provide configuration without local env files.
  }
}

const confirm = process.argv.includes("--confirm");
const batchFlag = process.argv.find((value) => value.startsWith("--batch-size="));
const parsedBatchSize = Number(batchFlag?.split("=")[1] ?? 50);
const batchSize = Math.max(1, Math.min(50, Math.trunc(parsedBatchSize) || 50));
const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

type BackfillRow = {
  user_id: string;
  question_id: string;
  prompt: string;
};

const pool = new Pool({ connectionString });
const config = resolveQuestionSearchConfig();
const stats = {
  mode: confirm ? "confirmed" : "dry-run",
  model: config.model,
  sourceVersion: QUESTION_SEARCH_SOURCE_VERSION,
  batchSize,
  candidates: 0,
  embedded: 0,
  skipped: 0,
  failures: 0,
  promptTokens: 0,
  estimatedPromptTokens: 0,
  providerCostUsd: 0,
  estimatedCostUsdAtDefaultRate: 0,
};

async function loadBatch(cursor: {
  userId: string;
  questionId: string;
} | null): Promise<BackfillRow[]> {
  const result = await pool.query<BackfillRow>(
    `SELECT q.user_id, q.id AS question_id, q.prompt
       FROM waxon_v2.questions q
       LEFT JOIN waxon_v2.question_search_embeddings qse
         ON qse.user_id = q.user_id
        AND qse.question_id = q.id
        AND qse.model = $1
        AND qse.source_version = $2
      WHERE q.lifecycle::text IN ('active','flagged','archived')
        AND qse.question_id IS NULL
        AND ($3::text IS NULL OR (q.user_id, q.id) > ($3, $4::uuid))
      ORDER BY q.user_id, q.id
      LIMIT $5`,
    [
      config.model,
      QUESTION_SEARCH_SOURCE_VERSION,
      cursor?.userId ?? null,
      cursor?.questionId ?? null,
      batchSize,
    ],
  );
  return result.rows;
}

async function upsertRows(rows: readonly BackfillRow[], embeddings: number[][]) {
  const values = rows.map((row, index) => ({
    user_id: row.user_id,
    question_id: row.question_id,
    model: config.model,
    source_version: QUESTION_SEARCH_SOURCE_VERSION,
    source_hash: questionSearchSourceHash(row.prompt),
    embedding: questionSearchVectorLiteral(embeddings[index] ?? []),
  }));
  await pool.query(
    `INSERT INTO waxon_v2.question_search_embeddings (
       user_id, question_id, model, source_version,
       source_hash, embedding
     )
     SELECT user_id, question_id::uuid, model,
            source_version, source_hash, embedding::halfvec(512)
       FROM jsonb_to_recordset($1::jsonb) AS item(
         user_id text, question_id text, model text,
         source_version integer, source_hash text, embedding text
       )
     ON CONFLICT (user_id, question_id, model, source_version)
     DO UPDATE SET
       source_hash = excluded.source_hash,
       embedding = excluded.embedding,
       updated_at = now()`,
    [JSON.stringify(values)],
  );
}

try {
  let cursor: { userId: string; questionId: string } | null = null;
  while (true) {
    const rows = await loadBatch(cursor);
    if (rows.length === 0) break;
    stats.candidates += rows.length;
    const estimatedTokens = Math.ceil(
      rows.reduce((sum, row) => sum + row.prompt.length, 0) / 4,
    );
    stats.estimatedPromptTokens += estimatedTokens;
    stats.estimatedCostUsdAtDefaultRate +=
      (estimatedTokens * 0.02) / 1_000_000;
    if (confirm) {
      for (const userId of new Set(rows.map((row) => row.user_id))) {
        const userRows = rows.filter((row) => row.user_id === userId);
        try {
          const result = await requestQuestionSearchEmbeddings({
            prompts: userRows.map((row) => row.prompt),
            userId,
          });
          await upsertRows(userRows, result.embeddings);
          stats.embedded += userRows.length;
          const promptTokens = Number(result.usage?.prompt_tokens);
          if (Number.isFinite(promptTokens)) stats.promptTokens += promptTokens;
          const cost = Number(result.usage?.cost);
          if (Number.isFinite(cost)) stats.providerCostUsd += cost;
        } catch (error) {
          stats.failures += userRows.length;
          console.error(
            JSON.stringify({
              event: "question_search_backfill_batch_failed",
              userQuestionCount: userRows.length,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      }
    } else {
      stats.skipped += rows.length;
    }
    const last = rows.at(-1);
    if (!last) break;
    cursor = { userId: last.user_id, questionId: last.question_id };
  }
  console.log(JSON.stringify(stats, null, 2));
  if (!confirm) {
    console.log(
      "Dry run only. Re-run with --confirm to create or repair embeddings.",
    );
  }
  if (stats.failures > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
