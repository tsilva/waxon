import { NextResponse } from "next/server";
import { submitAnswer } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    question: unknown;
    answer: unknown;
  }>;

  if (
    typeof payload.question !== "string" ||
    !payload.question.trim() ||
    typeof payload.answer !== "string"
  ) {
    return NextResponse.json(
      { ok: false, error: "question and answer are required" },
      { status: 400 },
    );
  }

  const result = await submitAnswer({
    question: payload.question,
    answer: payload.answer,
  });

  return NextResponse.json({ ok: true, evaluationId: result.evaluationId });
}
