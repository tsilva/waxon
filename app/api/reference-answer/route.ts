import { NextResponse } from "next/server";
import { generateReferenceAnswer } from "@/app/lib/referenceAnswer";
import {
  getStoredReferenceAnswer,
  saveReferenceAnswer,
} from "@/app/lib/sqliteStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    question: unknown;
  }>;

  if (typeof payload.question !== "string" || !payload.question.trim()) {
    return NextResponse.json(
      { error: "question is required" },
      { status: 400 },
    );
  }

  const question = payload.question.trim();
  const cachedAnswer = await getStoredReferenceAnswer(question);

  if (cachedAnswer) {
    return NextResponse.json({ answer: cachedAnswer });
  }

  const answer = await generateReferenceAnswer({
    question,
  });

  if (!answer.startsWith("Reference answer is unavailable")) {
    await saveReferenceAnswer({
      question,
      answer,
      now: Date.now(),
    });
  }

  return NextResponse.json({ answer });
}
