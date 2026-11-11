import { spawnSync } from "node:child_process";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL_UNPOOLED;

function verifyTarget() {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    url.hostname.includes("-pooler") ||
    !["require", "verify-ca", "verify-full"].includes(sslMode)
  ) {
    throw new Error("unexpected database target");
  }
}

async function appliedCount(expected) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
    );
    if (
      rows.length > expected.length ||
      rows.some((row, index) =>
        row.hash !== expected[index].hash ||
        String(row.created_at) !== String(expected[index].folderMillis))
    ) {
      throw new Error("unexpected migration history");
    }
    return rows.length;
  } finally {
    await client.end();
  }
}

try {
  verifyTarget();
  const expected = readMigrationFiles({ migrationsFolder: "drizzle-v2" });
  if (!expected.length) throw new Error("missing migration sources");
  const count = await appliedCount(expected);
  console.log(`Verified ${count} applied Waxon migrations in a read-only transaction.`);
  if (count < expected.length) {
    const migration = spawnSync("pnpm", ["db:migrate"], {
      stdio: "ignore",
      timeout: 120_000,
    });
    if (migration.status !== 0 || await appliedCount(expected) !== expected.length) {
      throw new Error("migration verification failed");
    }
    console.log(`Applied and verified ${expected.length - count} pending migrations.`);
  } else {
    console.log("Waxon migration history is current. No migration ran.");
  }
} catch {
  console.error("Waxon Production migration verification failed. Provider output was suppressed.");
  process.exitCode = 1;
}
