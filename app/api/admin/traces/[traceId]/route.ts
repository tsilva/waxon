import { NextResponse } from "next/server";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { getLlmTraceInteraction } from "@/app/lib/llmTraceStore";

export async function GET(_request: Request, context: { params: Promise<{ traceId: string }> }) {
  const user = await getCurrentUser({ fresh: true });
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { traceId } = await context.params;
  const interaction = await getLlmTraceInteraction(traceId);
  if (!interaction) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ interaction });
}
