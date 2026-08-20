import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getV2Db } from "../../db/v2/client.ts";
import { jobs } from "../../db/v2/schema.ts";

export async function claimV2Job(
  jobId: string,
  type: string,
): Promise<typeof jobs.$inferSelect | null> {
  const db = getV2Db();
  const now = new Date();
  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: new Date(now.getTime() + 4 * 60_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.type, type),
        or(
          and(eq(jobs.status, "pending"), lte(jobs.runAfter, now)),
          and(
            eq(jobs.status, "running"),
            or(isNull(jobs.lockedUntil), lte(jobs.lockedUntil, now)),
          ),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}
