import { NextResponse } from "next/server";
import { loadReviewSessionQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deckId = url.searchParams.get("deckId")?.trim() || null;

  return NextResponse.json(await loadReviewSessionQueue({ deckId }));
}
