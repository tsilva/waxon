import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { waxonApplication } from "@/app/lib/v2/application";
import { v2Error } from "@/app/lib/v2/http";

export async function GET() {
  try {
    const learner = await getCurrentUser();
    return NextResponse.json(
      await waxonApplication.forLearner(learner.id).review.open(),
    );
  } catch (error) {
    return v2Error(error);
  }
}
