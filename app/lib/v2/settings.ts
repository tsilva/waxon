import { eq, sql } from "drizzle-orm";
import { getV2Client, getV2Db } from "../../db/v2/client.ts";
import { learnerSettings } from "../../db/v2/schema.ts";
import type { V2LearnerSettings } from "./types.ts";

export type LearnerReviewDay = {
  timezone: string | null;
  effectiveTimezone: string;
  localDay: string;
  nextLocalDay: string;
  dayStart: Date;
  dayEnd: Date;
};

export function normalizeIanaTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) {
    throw new Error("A valid IANA timezone is required.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone })
      .resolvedOptions().timeZone;
  } catch {
    throw new Error("A valid IANA timezone is required.");
  }
}

export async function getLearnerSettings(
  userId: string,
): Promise<V2LearnerSettings> {
  const db = getV2Db();
  const [row] = await db
    .select({ timezone: learnerSettings.timezone })
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);
  return row ?? { timezone: null };
}

export async function updateLearnerTimezone(input: {
  userId: string;
  timezone: string;
}): Promise<V2LearnerSettings> {
  const timezone = normalizeIanaTimezone(input.timezone);
  return getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`review-queue:${input.userId}`}))`,
    );
    await tx
      .insert(learnerSettings)
      .values({ userId: input.userId })
      .onConflictDoNothing({ target: learnerSettings.userId });
    const [row] = await tx
      .update(learnerSettings)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(learnerSettings.userId, input.userId))
      .returning({ timezone: learnerSettings.timezone });
    if (!row) throw new Error("Could not save the learner timezone.");
    return row;
  });
}

export async function getLearnerReviewDay(
  userId: string,
  now: Date,
): Promise<LearnerReviewDay> {

  const [row] = await getV2Client().pool.query<{
    timezone: string | null;
    local_day: string;
    next_local_day: string;
    day_start: Date;
    day_end: Date;
  }>(
    `SELECT settings.timezone,
       ($2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date::text AS local_day,
       (($2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date + 1)::text AS next_local_day,
       date_trunc('day', $2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC')) AT TIME ZONE COALESCE(settings.timezone, 'UTC') AS day_start,
       (date_trunc('day', $2::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC')) + interval '1 day')
         AT TIME ZONE COALESCE(settings.timezone, 'UTC') AS day_end
       FROM waxon_v2.users learner
       LEFT JOIN waxon_v2.learner_settings settings ON settings.user_id = learner.id
       WHERE learner.id = $1`,
    [userId, now],
  ).then((result) => result.rows);
  if (!row) throw new Error("Could not determine the learner's Local Day.");
  return {
    timezone: row.timezone,
    effectiveTimezone: row.timezone ?? "UTC",
    localDay: row.local_day,
    nextLocalDay: row.next_local_day,
    dayStart: row.day_start,
    dayEnd: row.day_end,
  };
}

export function dateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
