import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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
  const scheduledUntil = now + 14 * DAY;
  const processedSince = now - 14 * DAY;
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

  const [{ value: dueCount = 0 } = { value: 0 }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(
      and(
        inArray(questions.deckId, rotationDeckIds),
        lte(questions.nextDue, now),
      ),
    );
  const [{ value: cardCount = 0 } = { value: 0 }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(inArray(questions.deckId, rotationDeckIds));

  const scheduled = await db
    .select({
      nextDue: questions.nextDue,
    })
    .from(questions)
    .where(
      and(
        inArray(questions.deckId, rotationDeckIds),
        lte(questions.nextDue, scheduledUntil),
      ),
    );

  const attempts = await db
    .select({
      resolvedAt: questionAttempts.resolvedAt,
      score: questionAttempts.score,
    })
    .from(questionAttempts)
    .where(
      and(
        inArray(questionAttempts.deckId, rotationDeckIds),
        gte(questionAttempts.resolvedAt, processedSince),
      ),
    )
    .orderBy(questionAttempts.resolvedAt);

  return NextResponse.json({
    now,
    dueCount,
    cardCount,
    scheduled: scheduled.filter((item) => Number.isFinite(item.nextDue)),
    attempts: attempts.filter(
      (item) => Number.isFinite(item.resolvedAt) && Number.isFinite(item.score),
    ),
  });
}
