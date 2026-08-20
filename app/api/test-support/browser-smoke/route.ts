import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getV2Db } from "@/app/db/v2/client";
import { questions } from "@/app/db/v2/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { BROWSER_SMOKE_QUESTIONS } from "@/app/lib/browserSmokeSupport";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { questionPromptKey } from "@/app/lib/v2/questionInput";
import { addQuestions, listLibrary } from "@/app/lib/v2/service";

function isEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    isLocalTestAuthEnabled() &&
    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT === "1"
  );
}

function disabledResponse() {
  return NextResponse.json(
    { ok: false, error: "Browser smoke support is disabled." },
    { status: 404 },
  );
}

export async function POST() {
  if (!isEnabled()) return disabledResponse();
  const user = await getCurrentUser();
  const promptKeys = BROWSER_SMOKE_QUESTIONS.map((item) =>
    questionPromptKey(item.prompt),
  );
  await getV2Db()
    .delete(questions)
    .where(
      and(eq(questions.userId, user.id), inArray(questions.targetKey, promptKeys)),
    );
  const result = await addQuestions({
    userId: user.id,
    idempotencyKey: `browser-smoke-${Date.now()}`,
    items: BROWSER_SMOKE_QUESTIONS.map((item) => ({
      ...item,
      answerMode: "exact" as const,
    })),
  });
  return NextResponse.json({ ok: true, questions: result.results });
}

export async function GET() {
  if (!isEnabled()) return disabledResponse();
  const user = await getCurrentUser();
  const prompts = new Set<string>(
    BROWSER_SMOKE_QUESTIONS.map((item) => item.prompt),
  );
  const library = await listLibrary({ userId: user.id, limit: 100 });
  return NextResponse.json({
    ok: true,
    questions: library.questions.filter((item) => prompts.has(item.prompt)),
  });
}
