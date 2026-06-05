import { NextResponse } from "next/server";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";
import { peekNextQuestion } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const currentUser = await getCurrentUser();

  if (!isAdminEmail(currentUser.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const [interactions, queueStatus] = await Promise.all([
    listLlmTraceInteractions(),
    peekNextQuestion(),
  ]);

  return NextResponse.json({
    interactions,
    dueCount: queueStatus.queueRemaining,
  });
}
