import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { getReviewSummary } from "@/app/lib/v2/service";

export async function GET() {
  const user = await getCurrentUser();

  return NextResponse.json(await getReviewSummary(user.id));
}
