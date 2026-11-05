import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import pg from "pg";
import { createRealtime, rawSql } from "@neon/realtime/server";
import { createRealtimeClient } from "@neon/realtime/client";
import { reviewRealtimeQuery } from "../app/lib/v2/reviewRealtimeQueries.ts";

// This URL must name an explicitly disposable database, never a learner's bank.
const databaseUrl = process.env.WAXON_REALTIME_TEST_DATABASE_URL;

test("Neon streams isolated revision deltas for committed changes, bulk writes and evaluation completion", {
  skip: !databaseUrl ? "WAXON_REALTIME_TEST_DATABASE_URL is not set" : false,
  timeout: 90_000,
}, async () => {
  assert.ok(databaseUrl);
  assert.ok(process.env.NEON_REALTIME_URL);
  assert.ok(process.env.NEON_REALTIME_SECRET);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const users = [`realtime-test-${randomUUID()}`, `realtime-test-${randomUUID()}`];
  const realtime = createRealtime({
    secret: process.env.NEON_REALTIME_SECRET,
    db: decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),
  });
  // Use the SDK's optional Node transport, whose close path can terminate a
  // socket. Node's browser-style WebSocket may keep the test process alive.
  const nativeWebSocket = globalThis.WebSocket;
  const sdkRequire = createRequire(import.meta.resolve("@neon/realtime"));
  globalThis.WebSocket = sdkRequire("ws").WebSocket;
  const client = createRealtimeClient({ url: process.env.NEON_REALTIME_URL });
  const revision = async (user: string) => {
    const result = await pool.query("SELECT revision FROM waxon_v2.review_revisions WHERE user_id = $1", [user]);
    return BigInt(result.rows[0]?.revision ?? 0);
  };
  try {
    for (const user of users) {
      await pool.query("INSERT INTO waxon_v2.users (id, display_name, email) VALUES ($1, 'Realtime test', $2)", [user, `${user}@example.invalid`]);
    }
    const subscribe = async (user: string) => {
      const query = reviewRealtimeQuery(user);
      assert.deepEqual(query.parameters.map((parameter) => parameter.value), [user]);
      // Reconstruct with this entry point's rawSql brand (Node's mixed .mts/.ts
      // loaders can instantiate the SDK twice; Next bundles one server module).
      return client.subscribe(await realtime.seal({ query: rawSql<{ revision: string }>(query.sql, [user]) }));
    };
    const [first, second] = await Promise.all(users.map(subscribe));
    await Promise.all([first.awaitRows((rows) => rows.length === 0, 30_000), second.awaitRows((rows) => rows.length === 0, 30_000)]);
    let deltaBatches = 0;
    first.onUpdate((update) => { if (update.type === "changes") deltaBatches++; });
    await pool.query("INSERT INTO waxon_v2.learner_settings (user_id, timezone) VALUES ($1, 'UTC'), ($2, 'UTC')", users);
    await Promise.all([first.awaitRows((rows) => rows[0]?.revision === "1", 15_000), second.awaitRows((rows) => rows[0]?.revision === "1", 15_000)]);

    // Two question rows in one statement bump only once for this learner.
    const questions = await pool.query(`INSERT INTO waxon_v2.questions (user_id, prompt, reference_answer, target_key)
      VALUES ($1, 'What is the sum of 2 and 2?', '4', $2),
             ($1, 'What is the sum of 3 and 3?', '6', $3) RETURNING id`, [users[0], randomUUID(), randomUUID()]);
    assert.equal(await revision(users[0]), BigInt(2));
    await first.awaitRows((rows) => rows[0]?.revision === "2", 15_000);
    assert.equal(second.getSnapshot().data?.[0]?.revision, "1");
    assert.deepEqual(Object.keys(first.getSnapshot().data![0]), ["revision"]);

    const submission = await pool.query(`INSERT INTO waxon_v2.answer_submissions
      (user_id, question_id, answer, submitted_at) VALUES ($1, $2, '4', now()) RETURNING id`, [users[0], questions.rows[0].id]);
    const evaluation = await pool.query(`INSERT INTO waxon_v2.evaluations
      (user_id, question_id, submission_id, evaluator) VALUES ($1, $2, $3, 'realtime-test') RETURNING id`,
    [users[0], questions.rows[0].id, submission.rows[0].id]);
    const before = await revision(users[0]);
    await pool.query("UPDATE waxon_v2.evaluations SET status = 'complete', feedback = 'Test feedback', completed_at = now() WHERE id = $1", [evaluation.rows[0].id]);
    assert.equal(await revision(users[0]), before + BigInt(1));
    await first.awaitRows((rows) => rows[0]?.revision === String(before + BigInt(1)), 15_000);

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("UPDATE waxon_v2.learner_settings SET timezone = 'Europe/Lisbon' WHERE user_id = $1", [users[0]]);
      await tx.query("ROLLBACK");
    } finally { tx.release(); }
    assert.equal(await revision(users[0]), before + BigInt(1));
    // A later committed change gives the stream a barrier after the rollback.
    await pool.query("UPDATE waxon_v2.learner_settings SET timezone = 'Europe/Lisbon' WHERE user_id = $1", [users[1]]);
    await second.awaitRows((rows) => rows[0]?.revision === "2", 15_000);
    assert.equal(first.getSnapshot().data?.[0]?.revision, String(before + BigInt(1)));
    assert.ok(deltaBatches > 0, "changes must arrive as deltas rather than repeated snapshots");
  } finally {
    client.close();
    globalThis.WebSocket = nativeWebSocket;
    for (const table of ["evaluations", "answer_submissions", "questions", "users"]) {
      const column = table === "users" ? "id" : "user_id";
      await pool.query(`DELETE FROM waxon_v2.${table} WHERE ${column} = ANY($1::text[])`, [users]);
    }
    await pool.end();
  }
});
