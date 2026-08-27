#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { replaceWithCleanBaseline } from "./lib/clean-break.mjs";
import { loadLocalEnvFiles, requireEnv } from "./lib/runtime.mjs";

loadLocalEnvFiles();

if (!process.argv.slice(2).includes("--confirm-clean-break")) {
  console.error(
    "Refusing to discard the database. Run `pnpm db:reset -- --confirm-clean-break` to replace Waxon data and migration metadata with the clean baseline.",
  );
  process.exit(2);
}

const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
const journal = JSON.parse(
  await readFile(
    new URL("../drizzle-v2/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
const [entry] = journal.entries ?? [];

if (
  journal.entries?.length !== 1 ||
  entry?.idx !== 0 ||
  entry?.tag !== "0000_clean_baseline" ||
  entry?.breakpoints !== true
) {
  throw new Error(
    "The destructive clean break requires exactly the verified 0000_clean_baseline migration",
  );
}

const baselineSql = await readFile(
  new URL(`../drizzle-v2/${entry.tag}.sql`, import.meta.url),
  "utf8",
);

await replaceWithCleanBaseline({
  connectionString,
  baselineSql,
  migrationTimestamp: entry.when,
});
