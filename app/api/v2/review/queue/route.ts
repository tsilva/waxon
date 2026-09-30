import { RequestTimings } from "@/app/lib/requestTimings";
import { getCurrentUser } from "@/app/lib/auth";
import { waxonApplication } from "@/app/lib/v2/application";
import { v2Error } from "@/app/lib/v2/http";

export async function GET(request: Request) {
  const timings = new RequestTimings();
  try {
    const learner = await getCurrentUser();
    timings.mark("auth");
    const searchParams = new URL(request.url).searchParams;
    const result = await waxonApplication.forLearner(learner.id).review.open({
        questionId: searchParams.get("questionId")?.slice(0, 200),
        afterQuestionId: searchParams.get("afterQuestionId")?.slice(0, 200),
      });
    timings.mark("review");
    return timings.json(result);
  } catch (error) {
    return v2Error(error);
  }
}
