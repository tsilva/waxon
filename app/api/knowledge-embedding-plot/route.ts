import { NextResponse } from "next/server";
import { knowledgeEmbeddingPlotStatus } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);

  return NextResponse.json(
    await knowledgeEmbeddingPlotStatus({
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    }),
  );
}
