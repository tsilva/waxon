import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/app/db/client";
import { questions, users } from "@/app/db/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { BROWSER_SMOKE_QUESTIONS } from "@/app/lib/browserSmokeSupport";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { questionSlug } from "@/app/lib/questionSlug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
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

    await tx
      .delete(questions)
      .where(
        and(
          eq(questions.userId, currentUser.id),
          inArray(
            questions.questionSlug,
            BROWSER_SMOKE_QUESTIONS.map((item) => questionSlug(item.question)),
          ),
        ),
      );

    await tx.insert(questions).values(
      BROWSER_SMOKE_QUESTIONS.map((item) => ({
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


  return NextResponse.json({
    ok: true,
    questions: BROWSER_SMOKE_QUESTIONS,
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
          BROWSER_SMOKE_QUESTIONS.map((item) => questionSlug(item.question)),
        ),
      ),
    );

  return NextResponse.json({
    ok: true,
    questions: rows,
  });
}
