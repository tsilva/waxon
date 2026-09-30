import { RequestTimings } from "@/app/lib/requestTimings";
import { getCurrentUser } from "@/app/lib/auth";
import { v2Error } from "@/app/lib/v2/http";
import { waxonApplication } from "@/app/lib/v2/application";

export async function GET() {
  const timings = new RequestTimings();
  try {
    const user = await getCurrentUser();
    timings.mark("auth");
    const result = await waxonApplication.forLearner(user.id).review.summary();
    timings.mark("summary");
    return timings.json(result);
  } catch (error) {
    return v2Error(error);
  }
}
