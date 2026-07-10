import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { reviewSummaryForUser } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();

  return NextResponse.json(await reviewSummaryForUser(user.id));
}
