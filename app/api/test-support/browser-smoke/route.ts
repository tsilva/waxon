import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/app/db/client";
import { decks, questions, users } from "@/app/db/schema";
import { isLocalTestAuthEnabled, localTestUser } from "@/app/lib/localTestAuth";
import { questionSlug } from "@/app/lib/questionSlug";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_DECK = {
  id: "browser-smoke",
  name: "Browser Smoke",
  slug: "browser-smoke",
} as const;

const TEST_QUESTIONS = [
  {
    question: "Browser smoke correct card: what exact token proves this answer is correct?",
    conciseAnswer: "browser-smoke-correct-token",
  },
  {
    question: "Browser smoke incorrect card: what exact token is intentionally omitted?",
    conciseAnswer: "browser-smoke-correct-token",
  },
] as const;

function isEnabled(): boolean {
  return (
    isLocalTestAuthEnabled() &&
    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT === "1"
  );
}

export async function POST() {
  if (!isEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Browser smoke support is disabled." },
      { status: 404 },
    );
  }

  const now = Date.now();

  await db.transaction(async (tx) => {
    await tx.delete(decks).where(eq(decks.id, TEST_DECK.id));

    await tx
      .insert(users)
      .values({
        id: localTestUser.id,
        displayName: localTestUser.displayName,
        email: localTestUser.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          displayName: localTestUser.displayName,
          email: localTestUser.email,
          updatedAt: now,
        },
      });

    await tx.insert(decks).values({
      id: TEST_DECK.id,
      userId: localTestUser.id,
      name: TEST_DECK.name,
      slug: TEST_DECK.slug,
      inReviewRotation: true,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(questions).values(
      TEST_QUESTIONS.map((item) => ({
        deckId: TEST_DECK.id,
        question: item.question,
        questionSlug: questionSlug(item.question),
        nextDue: 0,
        conciseAnswer: item.conciseAnswer,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });

  invalidateReviewQueue();

  return NextResponse.json({
    ok: true,
    deck: TEST_DECK,
    questions: TEST_QUESTIONS,
  });
}

export async function GET() {
  if (!isEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Browser smoke support is disabled." },
      { status: 404 },
    );
  }

  const rows = await db
    .select({
      question: questions.question,
      reviews: questions.reviews,
      nextDue: questions.nextDue,
      lastAnswer: questions.lastAnswer,
      lastAnswerSummary: questions.lastAnswerSummary,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(questions.deckId, TEST_DECK.id),
        eq(decks.id, TEST_DECK.id),
      ),
    );

  return NextResponse.json({
    ok: true,
    deck: TEST_DECK,
    questions: rows,
  });
}
