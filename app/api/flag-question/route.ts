import { NextResponse } from "next/server";
import {
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { QUESTION_TEXT_MAX_CHARS } from "@/app/lib/questionContract";
import { flagQuestion } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FLAG_BODY_BYTES = 4 * 1024;
const MAX_QUESTION_ID_CHARS = 80;

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_FLAG_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload = parsed.value as Partial<{
    questionId: unknown;
    question: unknown;
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
    maxLength: QUESTION_TEXT_MAX_CHARS,
    required: true,
  });

  if (!question.ok) {
    return question.response;
  }

  return NextResponse.json(
    await flagQuestion({
      questionId: questionId.value,
      question: question.value,
    }),
  );
}
