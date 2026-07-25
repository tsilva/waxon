#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

try {
  await pool.query('DROP SCHEMA IF EXISTS "waxon_v2" CASCADE');
} finally {
  await pool.end();
}

const migration = spawnSync("pnpm", ["db:migrate"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

process.exit(migration.status ?? 1);
