import { NextResponse } from "next/server";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    questions: unknown;
  }>;

  if (
    !Array.isArray(payload.questions) ||
    !payload.questions.every((question) => typeof question === "string")
  ) {
    return NextResponse.json(
      { ok: false, error: "questions must be an array of strings" },
      { status: 400 },
    );
  }

  const result = await addQuestionsToDeck({
    questions: payload.questions,
  });

  return NextResponse.json({ ok: true, added: result.added });
}
