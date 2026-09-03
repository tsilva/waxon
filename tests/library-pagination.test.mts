import assert from "node:assert/strict";
import test from "node:test";

import {
  libraryCursor,
  parseLibraryCursor,
} from "../app/lib/v2/libraryPagination.ts";

const QUESTION_ID = "00000000-0000-4000-8000-000000000001";

test("Library cursors preserve PostgreSQL microsecond precision", () => {
  const preciseTimestamp = "2026-08-14 12:37:49.468169+00";
  const incoming = Buffer.from(
    JSON.stringify({ updatedAt: preciseTimestamp, id: QUESTION_ID }),
  ).toString("base64url");

  const parsed = parseLibraryCursor(incoming);
  assert.ok(parsed);

  const outgoing = libraryCursor(parsed);
  const decoded = JSON.parse(
    Buffer.from(outgoing, "base64url").toString("utf8"),
  ) as { updatedAt: string };

  assert.equal(decoded.updatedAt, preciseTimestamp);
});
