import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  getQuestionAttemptsByQuestionIds,
  getQuestionSnapshot,
  getQuestionSnapshotById,
} from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const questionId = url.searchParams.get("questionId")?.trim();
  const question = url.searchParams.get("question")?.trim();
  const snapshot = questionId
    ? await getQuestionSnapshotById(questionId, { userId: user.id })
    : question
      ? await getQuestionSnapshot(question, { userId: user.id })
      : null;

  if (!snapshot) {
    return NextResponse.json({ attempts: [] });
  }

  const attemptsByQuestionId = await getQuestionAttemptsByQuestionIds({
    userId: user.id,
    questionIds: [snapshot.questionId],
  });

  return NextResponse.json({
    attempts: attemptsByQuestionId.get(snapshot.questionId) ?? [],
  });
}
