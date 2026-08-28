import { createHash } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

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

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function dropSchemaObjects(client, schemaName) {
  const dropCatalogObjects = async (objectKind, catalogQuery) => {
    const objects = await client.query(catalogQuery, [schemaName]);
    if (objects.rows.length === 0) return;
    await client.query(
      `DROP ${objectKind} IF EXISTS ${objects.rows
        .map(({ identity }) => identity)
        .join(", ")}`,
    );
  };

  await dropCatalogObjects(
    "MATERIALIZED VIEW",
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind = 'm'
      ORDER BY relation.relname`,
  );
  await dropCatalogObjects(
    "VIEW",
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind = 'v'
      ORDER BY relation.relname`,
  );
  await dropCatalogObjects(
    "TABLE",
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname`,
  );
  await dropCatalogObjects(
    "FOREIGN TABLE",
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind = 'f'
      ORDER BY relation.relname`,
  );
  await dropCatalogObjects(
    "SEQUENCE",
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS identity
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind = 'S'
      ORDER BY relation.relname`,
  );
  await dropCatalogObjects(
    "ROUTINE",
    `SELECT format(
              '%I.%I(%s)',
              namespace.nspname,
              routine.proname,
              pg_get_function_identity_arguments(routine.oid)
            ) AS identity
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = $1
      ORDER BY routine.proname, pg_get_function_identity_arguments(routine.oid)`,
  );
  await dropCatalogObjects(
    "TYPE",
    `SELECT format('%I.%I', namespace.nspname, type.typname) AS identity
       FROM pg_type type
       JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1
        AND type.typtype IN ('c', 'd', 'e', 'm', 'r')
        AND NOT EXISTS (
          SELECT 1
            FROM pg_type element_type
           WHERE element_type.typarray = type.oid
        )
      ORDER BY type.typname`,
  );

  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)}`);
}

export async function replaceWithCleanBaseline({
  connectionString,
  baselineSql,
  migrationTimestamp,
  subsequentMigrations = [],
}) {
  if (typeof baselineSql !== "string" || baselineSql.trim().length === 0) {
    throw new Error("The clean baseline SQL must be non-empty");
  }
  if (
    !Number.isSafeInteger(migrationTimestamp) ||
    migrationTimestamp < 0
  ) {
    throw new Error("The clean baseline migration timestamp must be a safe integer");
  }

  const migrations = [
    { sql: baselineSql, timestamp: migrationTimestamp },
    ...subsequentMigrations,
  ];
  for (const migration of migrations) {
    if (
      typeof migration?.sql !== "string" ||
      migration.sql.trim().length === 0 ||
      !Number.isSafeInteger(migration.timestamp) ||
      migration.timestamp < 0
    ) {
      throw new Error("Every migration must have non-empty SQL and a safe timestamp");
    }
  }
  const pool = new Pool({ connectionString });
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      `DROP TABLE IF EXISTS ${retiredPublicTables
        .map((name) => `"public".${quoteIdentifier(name)}`)
        .join(", ")}`,
    );
    await dropSchemaObjects(client, "waxon_v2");
    await client.query('DROP TABLE IF EXISTS "drizzle"."__drizzle_migrations"');
    await client.query('DROP SCHEMA IF EXISTS "drizzle"');

    for (const migration of migrations) {
      for (const statement of migration.sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
    }

    await client.query('CREATE SCHEMA "drizzle"');
    await client.query(`
      CREATE TABLE "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    for (const migration of migrations) {
      const migrationHash = createHash("sha256")
        .update(migration.sql)
        .digest("hex");
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
         VALUES ($1, $2)`,
        [migrationHash, migration.timestamp],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
