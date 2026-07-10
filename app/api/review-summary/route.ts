import { NextResponse } from "next/server";
import { reviewSummary } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await reviewSummary());
}
