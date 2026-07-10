import { NextResponse } from "next/server";
import { reviewActivity } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const recentAttemptsLimit = Number.parseInt(
    url.searchParams.get("recentAttemptsLimit") ?? "",
    10,
  );

  return NextResponse.json(
    await reviewActivity({
      recentAttemptsLimit: Number.isFinite(recentAttemptsLimit)
        ? recentAttemptsLimit
        : undefined,
    }),
  );
}
