import { NextResponse } from "next/server";
import { loadReviewStats } from "@/app/lib/stats";

export async function GET() {
  return NextResponse.json(await loadReviewStats());
}
