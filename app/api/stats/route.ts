import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/app/db/client";
import { decks, questionAttempts, questions } from "@/app/db/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { DAY } from "@/app/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
  const rotationDeckIds = db
    .select({ id: decks.id })
    .from(decks)
    .where(
      and(
        eq(decks.userId, user.id),
        eq(decks.inReviewRotation, true),
        isNull(decks.archivedAt),
      ),
    );

  const dueCountQuery = db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        inArray(questions.deckId, rotationDeckIds),
        isNull(questions.flaggedAt),
        lte(questions.nextDue, now),
      ),
    );
  const cardCountQuery = db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        inArray(questions.deckId, rotationDeckIds),
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
        inArray(questions.deckId, rotationDeckIds),
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
        inArray(questionAttempts.deckId, rotationDeckIds),
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

  return NextResponse.json({
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
  });
}
