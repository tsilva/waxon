import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { reviewActivityForUser } from "@/app/lib/reviewQueue";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const recentAttemptsLimit = Number.parseInt(
    url.searchParams.get("recentAttemptsLimit") ?? "",
    10,
  );
  const user = await getCurrentUser();

  return NextResponse.json(
    await reviewActivityForUser(user.id, {
      recentAttemptsLimit: Number.isFinite(recentAttemptsLimit)
        ? recentAttemptsLimit
        : undefined,
    }),
  );
}
