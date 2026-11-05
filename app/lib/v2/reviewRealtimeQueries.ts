import { rawSql } from "@neon/realtime/server";
import type { ReviewRealtimeRow } from "./reviewRealtimeTypes.ts";

// Neon beta cannot read the enum types in the domain tables. Statement-level
// triggers update this builtin-only, learner-scoped row in the same transaction.
// No learning content or history is included in the subscription.
export function reviewRealtimeQuery(userId: string) {
  return rawSql<ReviewRealtimeRow>(
    `SELECT revision FROM waxon_v2.review_revisions WHERE user_id = $1`,
    [userId],
  );
}
