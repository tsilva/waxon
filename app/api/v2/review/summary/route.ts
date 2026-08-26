import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { v2Error } from "@/app/lib/v2/http";
import { waxonApplication } from "@/app/lib/v2/application";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(
      await waxonApplication.forLearner(user.id).review.summary(),
    );
  } catch (error) {
    return v2Error(error);
  }
}
