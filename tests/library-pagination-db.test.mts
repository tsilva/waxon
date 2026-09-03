import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const TEST_DATABASE_URL =
  process.env.APPLICATION_CONTRACT_TEST_DATABASE_URL ??
  process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

test(
  "Library pagination reaches every Question sharing a precise timestamp",
  { skip: TEST_DATABASE_URL ? false : "A disposable test database is required" },
  async () => {
    if (!TEST_DATABASE_URL) return;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DATABASE_URL_UNPOOLED = TEST_DATABASE_URL;

    const [{ getV2Client }, { listLibrary }] = await Promise.all([
      import("../app/db/v2/client.ts"),
      import("../app/lib/v2/service.ts"),
    ]);
    const pool = getV2Client().pool;
    const learnerId = `library-pagination-${randomUUID()}`;

    try {
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, 'Library Pagination', $1 || '@waxon.invalid')`,
        [learnerId],
      );
      await pool.query(
        `INSERT INTO waxon_v2.questions
           (user_id, prompt, reference_answer, target_key, created_at, updated_at)
         SELECT $1,
                'Pagination Question ' || value,
                'Pagination Answer ' || value,
                md5($1 || ':' || value::text),
                '2026-08-14 12:37:49.468169+00'::timestamptz,
                '2026-08-14 12:37:49.468169+00'::timestamptz
           FROM generate_series(1, 51) value`,
        [learnerId],
      );

      const firstPage = await listLibrary({ userId: learnerId });
      assert.equal(firstPage.questions.length, 50);
      assert.ok(firstPage.nextCursor);

      const secondPage = await listLibrary({
        userId: learnerId,
        cursor: firstPage.nextCursor,
      });
      assert.equal(secondPage.questions.length, 1);
      assert.equal(secondPage.nextCursor, null);
      assert.equal(
        new Set([...firstPage.questions, ...secondPage.questions].map(({ id }) => id))
          .size,
        51,
      );
    } finally {
      await pool.query(`DELETE FROM waxon_v2.users WHERE id = $1`, [learnerId]);
    }
  },
);
