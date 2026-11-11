import assert from "node:assert/strict";
import test from "node:test";

test("an idle database disconnect does not escape as an uncaught event", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/fixture";
  const globalClient = globalThis as typeof globalThis & { waxonV2PgDb?: unknown };
  assert.equal(globalClient.waxonV2PgDb, undefined);
  const { getV2Client } = await import("../app/db/v2/client.ts");
  const client = getV2Client();
  try {
    const failure = new Error("Connection terminated unexpectedly");
    assert.doesNotThrow(() => client.pool.emit("error", failure));
    assert.equal(client.pool.listenerCount("error"), 1);
    assert.equal(getV2Client(), client);
  } finally {
    await client.pool.end();
    delete globalClient.waxonV2PgDb;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
