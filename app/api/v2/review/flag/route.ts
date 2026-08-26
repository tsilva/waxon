import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { waxonApplication } from "@/app/lib/v2/application";
import { isRecord, v2Error } from "@/app/lib/v2/http";

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;

  try {
    const learner = await getCurrentUser();
    if (!isRecord(parsed.value)) {
      throw new Error("A Review Flag payload is required.");
    }
    const review = waxonApplication.forLearner(learner.id).review;
    const result = await review.flag({
      questionId:
        typeof parsed.value.questionId === "string"
          ? parsed.value.questionId
          : "",
      reasons: parsed.value.reasons,
      detail: parsed.value.detail,
    });
    return NextResponse.json({ ok: true, ...result, review: await review.open() });
  } catch (error) {
    return v2Error(error);
  }
}
