import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import { waxonApplication } from "@/app/lib/v2/application";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 80 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-review-answer",
      rules: [{ name: "ten-minutes", max: 120, windowMs: 10 * 60_000 }],
    });
    if (limited) {
      return limited;
    }
    if (!isRecord(parsed.value)) {
      throw new Error("An answer payload is required.");
    }
    const questionVersionId =
      typeof parsed.value.questionVersionId === "string"
        ? parsed.value.questionVersionId
        : "";
    const answer =
      typeof parsed.value.answer === "string"
        ? parsed.value.answer.slice(0, 65_536)
        : "";
    const idempotencyKey =
      typeof parsed.value.idempotencyKey === "string"
        ? parsed.value.idempotencyKey.slice(0, 200)
        : "";
    if (!questionVersionId || !answer.trim() || !idempotencyKey) {
      throw new Error(
        "A Review Question, free-text answer, and idempotency key are required.",
      );
    }
    const evaluation = await application.review.submitAnswer({
      questionVersionId,
      answer,
      idempotencyKey,
    });
    if (evaluation.status === "pending") {
      await startBackgroundJobs(user.id, 4);
    }
    return NextResponse.json(evaluation, { status: 202 });
  } catch (error) {
    return v2Error(error);
  }
}
