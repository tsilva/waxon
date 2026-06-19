import { and, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/app/db/client";
import { questionAttempts, questions } from "@/app/db/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { DAY } from "@/app/lib/scheduler";

export type StatsResponse = {
  now: number;
  dueCount: number;
  cardCount: number;
  scheduledBuckets: Array<{
    dayStart: number;
    value: number;
  }>;
  processedBuckets: Array<{
    dayStart: number;
    value: number;
    averageScore: number;
  }>;
};

export async function loadReviewStats(): Promise<StatsResponse> {
  const user = await getCurrentUser();
  const now = Date.now();
  const today = new Date(now);
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const scheduledUntil = todayStart + 14 * DAY;
  const processedSince = todayStart - 13 * DAY;
  const processedUntil = todayStart + DAY;
  const dueCountQuery = db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        eq(questions.userId, user.id),
        isNull(questions.flaggedAt),
        lte(questions.nextDue, now),
      ),
    );
  const cardCountQuery = db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        eq(questions.userId, user.id),
        isNull(questions.flaggedAt),
      ),
    );
  const scheduledBucketsQuery = db
    .select({
      dayStart: sql<number>`
        CASE
          WHEN ${questions.nextDue} <= ${now} THEN ${todayStart}
          ELSE (
            extract(epoch from date_trunc(
              'day',
              to_timestamp(${questions.nextDue} / 1000.0)
            )) * 1000
          )::bigint
        END
      `,
      value: sql<number>`count(*)::int`,
    })
    .from(questions)
    .where(
      and(
        eq(questions.userId, user.id),
        isNull(questions.flaggedAt),
        lt(questions.nextDue, scheduledUntil),
      ),
    )
    .groupBy(sql`1`);
  const processedBucketsQuery = db
    .select({
      dayStart: sql<number>`
        (
          extract(epoch from date_trunc(
            'day',
            to_timestamp(${questionAttempts.resolvedAt} / 1000.0)
          )) * 1000
        )::bigint
      `,
      value: sql<number>`count(*)::int`,
      averageScore: sql<number>`avg(${questionAttempts.score})::float8`,
    })
    .from(questionAttempts)
    .where(
      and(
        eq(questionAttempts.userId, user.id),
        gte(questionAttempts.resolvedAt, processedSince),
        lt(questionAttempts.resolvedAt, processedUntil),
      ),
    )
    .groupBy(sql`1`);
  const [
    [{ value: dueCount = 0 } = { value: 0 }],
    [{ value: cardCount = 0 } = { value: 0 }],
    scheduledBuckets,
    processedBuckets,
  ] = await Promise.all([
    dueCountQuery,
    cardCountQuery,
    scheduledBucketsQuery,
    processedBucketsQuery,
  ]);

  return {
    now,
    dueCount,
    cardCount,
    scheduledBuckets: scheduledBuckets
      .map((item) => ({
        dayStart: Number(item.dayStart),
        value: Number(item.value),
      }))
      .filter(
        (item) => Number.isFinite(item.dayStart) && Number.isFinite(item.value),
      ),
    processedBuckets: processedBuckets
      .map((item) => ({
        dayStart: Number(item.dayStart),
        value: Number(item.value),
        averageScore: Number(item.averageScore),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.dayStart) &&
          Number.isFinite(item.value) &&
          Number.isFinite(item.averageScore),
      ),
  };
}
