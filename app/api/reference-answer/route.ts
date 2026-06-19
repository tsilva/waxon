import { NextResponse } from "next/server";
import {
  generateReferenceAnswer,
  hasReferenceAnswerExplanation,
} from "@/app/lib/referenceAnswer";
import {
  getQuestionSnapshotById,
  saveReferenceAnswer,
} from "@/app/lib/postgresStore";
import { getCurrentUser } from "@/app/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizedQuestion(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    questionId: unknown;
    question: unknown;
  }>;

  if (typeof payload.question !== "string" || !payload.question.trim()) {
    return NextResponse.json(
      { error: "question is required" },
      { status: 400 },
    );
  }

  const question = payload.question.trim();
  const questionId =
    typeof payload.questionId === "string" && payload.questionId.trim()
      ? payload.questionId.trim()
      : null;
  const user = await getCurrentUser();
  const snapshot = questionId
    ? await getQuestionSnapshotById(questionId, { userId: user.id })
    : null;

  if (questionId && !snapshot) {
    return NextResponse.json(
      { error: "Question not found." },
      { status: 404 },
    );
  }

  if (
    snapshot &&
    normalizedQuestion(snapshot.question) !== normalizedQuestion(question)
  ) {
    return NextResponse.json(
      { error: "Question mismatch." },
      { status: 400 },
    );
  }

  const cachedAnswer = snapshot?.referenceAnswer?.trim() ?? "";

  if (cachedAnswer && hasReferenceAnswerExplanation(cachedAnswer)) {
    return NextResponse.json({ answer: cachedAnswer });
  }

  const answer = await generateReferenceAnswer({
    question,
    userId: user.id,
  });

  if (snapshot && !answer.startsWith("Reference answer is unavailable")) {
    await saveReferenceAnswer({
      questionId: snapshot.questionId,
      question,
      answer,
      now: Date.now(),
      userId: user.id,
    });
  }

  return NextResponse.json({ answer });
}
