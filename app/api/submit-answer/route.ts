import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { submitAnswer } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBMIT_BODY_BYTES = 16 * 1024;
const MAX_QUESTION_ID_CHARS = 80;
const MAX_QUESTION_CHARS = 1_200;
const MAX_ANSWER_CHARS = 4_000;

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_SUBMIT_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload = parsed.value as Partial<{
    questionId: unknown;
    question: unknown;
    answer: unknown;
  }>;
  const questionId = normalizeBoundedText(payload?.questionId, {
    field: "questionId",
    maxLength: MAX_QUESTION_ID_CHARS,
    required: true,
  });

  if (!questionId.ok) {
    return questionId.response;
  }

  const question = normalizeBoundedText(payload?.question, {
    field: "question",
    maxLength: MAX_QUESTION_CHARS,
    required: true,
  });

  if (!question.ok) {
    return question.response;
  }

  if (typeof payload?.answer !== "string") {
    return NextResponse.json(
      { ok: false, error: "answer is required." },
      { status: 400 },
    );
  }

  const answer = normalizeBoundedText(payload?.answer, {
    field: "answer",
    maxLength: MAX_ANSWER_CHARS,
    required: false,
  });

  if (!answer.ok) {
    return answer.response;
  }

  const user = await getCurrentUser();
  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "submit-answer",
    rules: [
      { name: "minute", max: 20, windowMs: 60_000 },
      { name: "day", max: 300, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const result = await submitAnswer({
      questionId: questionId.value,
      question: question.value,
      answer: answer.value,
    });

    return NextResponse.json({
      ok: true,
      evaluationId: result.evaluationId,
      traceId: result.traceId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not submit answer.";
    console.error("[waxon] submit answer failed", {
      error: message,
      cause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : null,
    });
    const status =
      message === "Question not found." ||
      message === "Question mismatch." ||
      message === "Question is not in review."
        ? 400
        : 500;

    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
