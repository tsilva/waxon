import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { waxonApplication } from "@/app/lib/v2/application";
import { v2Error } from "@/app/lib/v2/http";

export async function GET(request: Request) {
  try {
    const learner = await getCurrentUser();
    const searchParams = new URL(request.url).searchParams;
    return NextResponse.json(
      await waxonApplication.forLearner(learner.id).review.open({
        questionId: searchParams.get("questionId")?.slice(0, 200),
        afterQuestionId: searchParams.get("afterQuestionId")?.slice(0, 200),
      }),
    );
  } catch (error) {
    return v2Error(error);
  }
}
