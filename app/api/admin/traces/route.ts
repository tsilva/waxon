import { NextResponse } from "next/server";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const currentUser = await getCurrentUser();

  if (!isAdminEmail(currentUser.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const interactions = await listLlmTraceInteractions();

  return NextResponse.json({
    interactions,
  });
}
