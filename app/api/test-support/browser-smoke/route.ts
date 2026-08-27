import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
  BROWSER_SMOKE_QUESTIONS,
  BROWSER_SMOKE_TIMEZONE_QUESTION,
} from "@/app/lib/browserSmokeSupport";
import {
  BrowserSmokeSeedConflict,
  seedBrowserSmokeJourney,
} from "@/app/lib/browserSmokeFixture";
import {
  isBrowserAcceptanceLearnerEnabled,
  isLocalTestAuthEnabled,
} from "@/app/lib/localTestAuth";
import {
  getQuestionLearningEvidence,
  listLibrary,
} from "@/app/lib/v2/service";

function isEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    isLocalTestAuthEnabled() &&
    isBrowserAcceptanceLearnerEnabled() &&
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
  const learner = await getCurrentUser();
  try {
    return NextResponse.json({
      ok: true,
      ...(await seedBrowserSmokeJourney(learner.id)),
    });
  } catch (error) {
    if (!(error instanceof BrowserSmokeSeedConflict)) throw error;
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        activeQuestions: error.activeQuestions,
      },
      { status: 409 },
    );
  }
}

export async function GET() {
  if (!isEnabled()) return disabledResponse();
  const learner = await getCurrentUser();
  const prompts = new Set<string>(
    [
      BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT,
      BROWSER_SMOKE_TIMEZONE_QUESTION.prompt,
      ...BROWSER_SMOKE_QUESTIONS.map((item) => item.prompt),
    ],
  );
  const questionBank = await listLibrary({ userId: learner.id, limit: 100 });
  const namedQuestions = questionBank.questions.filter((item) =>
    prompts.has(item.prompt),
  );
  return NextResponse.json({
    ok: true,
    questions: await Promise.all(
      namedQuestions.map(async (item) => ({
        ...item,
        evidence: await getQuestionLearningEvidence({
          userId: learner.id,
          questionId: item.id,
        }),
      })),
    ),
  });
}
