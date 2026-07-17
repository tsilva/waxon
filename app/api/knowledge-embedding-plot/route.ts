import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { knowledgeEmbeddingPlotStatus } from "@/app/lib/knowledgeEmbeddingPlot";
import { readQuestionEmbeddingProjections } from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const user = await getCurrentUser();

  return NextResponse.json(
    await knowledgeEmbeddingPlotStatus(
      {
        userId: user.id,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      },
      readQuestionEmbeddingProjections,
    ),
  );
}
