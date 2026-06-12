import { NextResponse } from "next/server";
import { loadReviewStats } from "@/app/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await loadReviewStats());
}
