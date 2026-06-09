import { NextResponse } from "next/server";
import { queueStatus } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isEnabled(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }

  return value !== "0" && value !== "false";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const sort = url.searchParams.get("sort");
  const deckId = url.searchParams.get("deckId")?.trim();
  const mode = url.searchParams.get("mode");
  const query = url.searchParams.get("query")?.trim();

  return NextResponse.json(
    await queueStatus({
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      sortKey: sort === "creation-date" ? "creation-date" : "review-date",
      deckId: deckId || undefined,
      query: query || undefined,
      includeReviewQueue:
        mode === "review"
          ? false
          : isEnabled(url.searchParams.get("includeReviewQueue"), true),
      includeQuestionAttempts: isEnabled(
        url.searchParams.get("includeQuestionAttempts"),
        false,
      ),
      includeRecentAttempts: isEnabled(
        url.searchParams.get("includeRecentAttempts"),
        true,
      ),
      includeDeckEmbeddingPlot: isEnabled(
        url.searchParams.get("includeDeckEmbeddingPlot"),
        false,
      ),
      includeQueueCounts: isEnabled(
        url.searchParams.get("includeQueueCounts"),
        true,
      ),
    }),
  );
}
