import { eq } from "drizzle-orm";
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
  await db
    .insert(learnerSettings)
    .values({ userId })
    .onConflictDoNothing({ target: learnerSettings.userId });
  const [row] = await db
    .select({ timezone: learnerSettings.timezone })
    .from(learnerSettings)
    .where(eq(learnerSettings.userId, userId))
    .limit(1);
  if (!row) throw new Error("Could not load learner settings.");
  return row;
}

export async function updateLearnerTimezone(input: {
  userId: string;
  timezone: string;
}): Promise<V2LearnerSettings> {
  const timezone = normalizeIanaTimezone(input.timezone);
  await getLearnerSettings(input.userId);
  const [row] = await getV2Db()
    .update(learnerSettings)
    .set({ timezone, updatedAt: new Date() })
    .where(eq(learnerSettings.userId, input.userId))
    .returning({ timezone: learnerSettings.timezone });
  if (!row) throw new Error("Could not save the learner timezone.");
  return row;
}

export async function getLearnerReviewDay(
  userId: string,
  now: Date,
): Promise<LearnerReviewDay> {
  const settings = await getLearnerSettings(userId);
  const effectiveTimezone = settings.timezone ?? "UTC";
  const [row] = await getV2Client().pool.query<{
    local_day: string;
    next_local_day: string;
    day_start: Date;
    day_end: Date;
  }>(
    `SELECT
       ($2::timestamptz AT TIME ZONE $1)::date::text AS local_day,
       (($2::timestamptz AT TIME ZONE $1)::date + 1)::text AS next_local_day,
       date_trunc('day', $2::timestamptz AT TIME ZONE $1) AT TIME ZONE $1 AS day_start,
       (date_trunc('day', $2::timestamptz AT TIME ZONE $1) + interval '1 day')
         AT TIME ZONE $1 AS day_end`,
    [effectiveTimezone, now],
  ).then((result) => result.rows);
  if (!row) throw new Error("Could not determine the learner's Local Day.");
  return {
    timezone: settings.timezone,
    effectiveTimezone,
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
