import assert from "node:assert/strict";
import test from "node:test";
import { appUserIdForClerkUser } from "../app/lib/clerkIdentity.ts";

test("the current Clerk subject is the sole Waxon learner identity", () => {
  assert.equal(
    appUserIdForClerkUser({ id: "user_currentClerkId" }),
    "clerk:user_currentClerkId",
  );
});
