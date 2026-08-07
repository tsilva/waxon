import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import { submitReviewAnswer } from "@/app/lib/v2/service";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 80 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
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
    const itemId =
      typeof parsed.value.itemId === "string" ? parsed.value.itemId : "";
    const answer =
      typeof parsed.value.answer === "string"
        ? parsed.value.answer.slice(0, 65_536)
        : "";
    if (!itemId || !answer.trim()) {
      throw new Error("A Review item and free-text answer are required.");
    }
    const evaluation = await submitReviewAnswer({
      userId: user.id,
      itemId,
      answer,
    });
    if (evaluation.status === "pending") {
      await startBackgroundJobs(user.id, 4);
    }
    return NextResponse.json(evaluation, { status: 202 });
  } catch (error) {
    return v2Error(error);
  }
}
