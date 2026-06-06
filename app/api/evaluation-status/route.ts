import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { getAnswerEvaluationsByIds } from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = [
    ...url.searchParams.getAll("evaluationId"),
    ...(url.searchParams.get("ids")?.split(",") ?? []),
  ]
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ evaluations: [] });
  }

  const user = await getCurrentUser();
  const evaluations = await getAnswerEvaluationsByIds({
    userId: user.id,
    ids,
  });

  return NextResponse.json({ evaluations });
}
