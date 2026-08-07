#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Pool } from "@neondatabase/serverless";
import { loadLocalEnvFiles, requireEnv } from "./lib/runtime.mjs";

loadLocalEnvFiles();

if (process.argv[2] !== "--confirm-purge-v2") {
  console.error(
    "Refusing to purge. Run `pnpm db:reset -- --confirm-purge-v2` to drop only the waxon_v2 schema.",
  );
  process.exit(2);
}

const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
const pool = new Pool({ connectionString });
const journal = JSON.parse(
  await readFile(
    new URL("../drizzle-v2/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
const migrationTimestamps = journal.entries.map((entry) => String(entry.when));

try {
  await pool.query("BEGIN");
  await pool.query('DROP SCHEMA IF EXISTS "waxon_v2" CASCADE');
  const migrationTable = await pool.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS name",
  );
  if (migrationTable.rows[0]?.name) {
    await pool.query(
      'DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])',
      [migrationTimestamps],
    );
  }
  await pool.query("COMMIT");
} catch (error) {
  await pool.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}

const migration = spawnSync("pnpm", ["db:migrate"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

process.exit(migration.status ?? 1);
