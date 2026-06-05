import { NextResponse } from "next/server";
import { queueStatus } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const sort = url.searchParams.get("sort");
  const deckId = url.searchParams.get("deckId")?.trim();

  return NextResponse.json(
    await queueStatus({
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      sortKey: sort === "creation-date" ? "creation-date" : "review-date",
      deckId: deckId || undefined,
    }),
  );
}
