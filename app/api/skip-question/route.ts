import { NextResponse } from "next/server";
import { skipQuestion } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    questionId?: unknown;
    question?: unknown;
  };

  if (typeof body.question !== "string") {
    return NextResponse.json(
      {
        error: "Question is required.",
      },
      {
        status: 400,
      },
    );
  }

  const questionId =
    typeof body.questionId === "string" && body.questionId.trim()
      ? body.questionId.trim()
      : null;

  return NextResponse.json(
    await skipQuestion({
      questionId,
      question: body.question,
    }),
  );
}
