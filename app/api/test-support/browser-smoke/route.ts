import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/app/db/client";
import { questions, users } from "@/app/db/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { questionSlug } from "@/app/lib/questionSlug";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const currentUser = await getCurrentUser();

  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id: currentUser.id,
        displayName: currentUser.displayName,
        email: currentUser.email,
        avatarUrl: currentUser.avatarUrl,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          displayName: currentUser.displayName,
          email: currentUser.email,
          avatarUrl: currentUser.avatarUrl,
          updatedAt: now,
        },
      });

    for (const item of TEST_QUESTIONS) {
      await tx
        .delete(questions)
        .where(
          and(
            eq(questions.userId, currentUser.id),
            eq(questions.questionSlug, questionSlug(item.question)),
          ),
        );
    }

    await tx.insert(questions).values(
      TEST_QUESTIONS.map((item) => ({
        userId: currentUser.id,
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

  const currentUser = await getCurrentUser();
  const rows = await db
    .select({
      question: questions.question,
      reviews: questions.reviews,
      nextDue: questions.nextDue,
      lastAnswer: questions.lastAnswer,
      lastAnswerSummary: questions.lastAnswerSummary,
    })
    .from(questions)
    .where(
      and(
        eq(questions.userId, currentUser.id),
        inArray(
          questions.questionSlug,
          TEST_QUESTIONS.map((item) => questionSlug(item.question)),
        ),
      ),
    );

  return NextResponse.json({
    ok: true,
    questions: rows,
  });
}
