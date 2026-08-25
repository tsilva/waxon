import assert from "node:assert/strict";
import test from "node:test";
import { appUserIdForClerkUser } from "../app/lib/clerkIdentity.ts";

test("a migrated Clerk identity retains its canonical Waxon learner ID", () => {
  assert.equal(
    appUserIdForClerkUser({
      id: "user_newClerkId",
      externalId: "clerk:user_legacyClerkId",
    }),
    "clerk:user_legacyClerkId",
  );
});

test("a new Clerk identity falls back to its current Clerk user ID", () => {
  assert.equal(
    appUserIdForClerkUser({ id: "user_newClerkId", externalId: null }),
    "clerk:user_newClerkId",
  );
});

test("a noncanonical external ID cannot select a Waxon learner", () => {
  for (const externalId of ["", "local-test", "user_legacyClerkId"]) {
    assert.equal(
      appUserIdForClerkUser({ id: "user_newClerkId", externalId }),
      "clerk:user_newClerkId",
    );
  }
});
