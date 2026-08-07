import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { v2Error } from "@/app/lib/v2/http";
import { getOrCreateReviewSession } from "@/app/lib/v2/service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getOrCreateReviewSession(user.id));
  } catch (error) {
    return v2Error(error);
  }
}
