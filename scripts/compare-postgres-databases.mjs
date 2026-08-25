import pg from "pg";

const { Client } = pg;

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function inventory(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const tableResult = await client.query(`
      select schemaname as schema_name, tablename as table_name
      from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
      order by schemaname, tablename
    `);
    const tables = [];

    for (const table of tableResult.rows) {
      const result = await client.query(
        `select count(*)::bigint as count from ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`,
      );
      tables.push({
        name: `${table.schema_name}.${table.table_name}`,
        count: result.rows[0].count,
      });
    }

    const extensions = (
      await client.query(`
        select extname
        from pg_extension
        where extname <> 'plpgsql'
        order by extname
      `)
    ).rows.map((row) => row.extname);

    const foreignKeys = (
      await client.query(`
        select
          n.nspname || '.' || c.relname || '.' || con.conname as name,
          con.convalidated as validated
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where con.contype = 'f'
          and n.nspname not in ('pg_catalog', 'information_schema')
        order by 1
      `)
    ).rows;

    const sequences = (
      await client.query(`
        select schemaname || '.' || sequencename as name, last_value::text
        from pg_sequences
        where schemaname not in ('pg_catalog', 'information_schema')
        order by 1
      `)
    ).rows;

    return { extensions, foreignKeys, sequences, tables };
  } finally {
    await client.end();
  }
}

function compareNamedRows(sourceRows, destinationRows, serialize) {
  const source = new Map(sourceRows.map((row) => [row.name, serialize(row)]));
  const destination = new Map(
    destinationRows.map((row) => [row.name, serialize(row)]),
  );
  const names = [...new Set([...source.keys(), ...destination.keys()])].sort();

  return names.flatMap((name) => {
    const sourceValue = source.get(name);
    const destinationValue = destination.get(name);
    return sourceValue === destinationValue
      ? []
      : [{ name, source: sourceValue, destination: destinationValue }];
  });
}

const [source, destination] = await Promise.all([
  inventory(requireEnvironment("SOURCE_DATABASE_URL")),
  inventory(requireEnvironment("DESTINATION_DATABASE_URL")),
]);

const tableMismatches = compareNamedRows(
  source.tables,
  destination.tables,
  (row) => row.count,
);
const foreignKeyMismatches = compareNamedRows(
  source.foreignKeys,
  destination.foreignKeys,
  (row) => String(row.validated),
);
const sequenceMismatches = compareNamedRows(
  source.sequences,
  destination.sequences,
  (row) => row.last_value,
);
const extensionsMatch =
  JSON.stringify(source.extensions) === JSON.stringify(destination.extensions);
const sourceRows = source.tables.reduce(
  (sum, table) => sum + BigInt(table.count),
  0n,
);
const destinationRows = destination.tables.reduce(
  (sum, table) => sum + BigInt(table.count),
  0n,
);

console.log(
  `tables=${destination.tables.length} tableMismatches=${tableMismatches.length} sourceRows=${sourceRows} destinationRows=${destinationRows}`,
);
console.log(
  `foreignKeys=${destination.foreignKeys.length} foreignKeyMismatches=${foreignKeyMismatches.length}`,
);
console.log(
  `sequences=${destination.sequences.length} sequenceMismatches=${sequenceMismatches.length}`,
);
console.log(
  `extensions=${destination.extensions.join(",")} extensionsMatch=${extensionsMatch}`,
);

for (const [kind, mismatches] of [
  ["table", tableMismatches],
  ["foreign-key", foreignKeyMismatches],
  ["sequence", sequenceMismatches],
]) {
  for (const mismatch of mismatches) {
    console.error(
      `${kind} mismatch ${mismatch.name}: source=${mismatch.source ?? "missing"} destination=${mismatch.destination ?? "missing"}`,
    );
  }
}

if (
  tableMismatches.length > 0 ||
  foreignKeyMismatches.length > 0 ||
  sequenceMismatches.length > 0 ||
  !extensionsMatch
) {
  process.exitCode = 1;
}
