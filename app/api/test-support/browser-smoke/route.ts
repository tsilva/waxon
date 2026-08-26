import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getV2Db } from "@/app/db/v2/client";
import { questions } from "@/app/db/v2/schema";
import { getCurrentUser } from "@/app/lib/auth";
import { BROWSER_SMOKE_QUESTIONS } from "@/app/lib/browserSmokeSupport";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { questionPromptKey } from "@/app/lib/v2/questionInput";
import {
  addQuestions,
  listLibrary,
  mutateQuestionLifecycle,
  replaceQuestion,
  type AddQuestionResult,
} from "@/app/lib/v2/service";

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
  const existing = await getV2Db()
    .select({
      id: questions.id,
      lifecycle: questions.lifecycle,
      targetKey: questions.targetKey,
    })
    .from(questions)
    .where(
      and(
        eq(questions.userId, user.id),
        inArray(questions.targetKey, promptKeys),
      ),
    );
  const existingByTarget = new Map<string, (typeof existing)[number]>();
  for (const candidate of existing) {
    const retained = existingByTarget.get(candidate.targetKey);
    if (!retained || candidate.lifecycle === "active") {
      existingByTarget.set(candidate.targetKey, candidate);
    }
  }
  const results: AddQuestionResult[] = [];
  for (const item of BROWSER_SMOKE_QUESTIONS) {
    const targetKey = questionPromptKey(item.prompt);
    const prior = existingByTarget.get(targetKey);
    if (prior) {
      const replacement = await replaceQuestion({
        userId: user.id,
        questionId: prior.id,
        ...item,
      });
      if (
        replacement.status === "unchanged" &&
        replacement.lifecycle !== "active"
      ) {
        await mutateQuestionLifecycle({
          userId: user.id,
          questionId: replacement.questionId,
          action: "restore",
        });
      }
      results.push({
        id: replacement.questionId,
        status: replacement.status === "replaced" ? "created" : "existing",
        outcome:
          replacement.status === "replaced"
            ? "created_active"
            : "exact_duplicate",
        lifecycle: "active",
        flags: [],
        answerStandardConflict: false,
      });
      continue;
    }
    const created = await addQuestions({
      userId: user.id,
      idempotencyKey: `browser-smoke-${targetKey}-${Date.now()}`,
      items: [item],
    });
    results.push(...created.results);
  }
  return NextResponse.json({ ok: true, questions: results });
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
    questions: library.questions.filter(
      (item) =>
        prompts.has(item.prompt) &&
        item.lifecycle === "active",
    ),
  });
}
