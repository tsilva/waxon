import { NextResponse } from "next/server";
import { loadReviewSessionQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deckId = url.searchParams.get("deckId")?.trim() || null;
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const excludeQuestionIds = url.searchParams
    .getAll("excludeQuestionId")
    .map((questionId) => questionId.trim())
    .filter(Boolean);

  return NextResponse.json(
    await loadReviewSessionQueue({
      deckId,
      excludeQuestionIds,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    }),
  );
}
