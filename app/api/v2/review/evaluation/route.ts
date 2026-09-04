import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  asRecallResult,
  isRecord,
  v2Error,
} from "@/app/lib/v2/http";
import { waxonApplication } from "@/app/lib/v2/application";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    const submissionId = new URL(request.url).searchParams.get("submissionId");
    if (!submissionId) {
      throw new Error("submissionId is required.");
    }
    return NextResponse.json(
      await application.review.getEvaluation(submissionId),
    );
  } catch (error) {
    return v2Error(error);
  }
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 16 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    if (!isRecord(parsed.value)) {
      throw new Error("An evaluation result is required.");
    }
    const submissionId =
      typeof parsed.value.submissionId === "string"
        ? parsed.value.submissionId
        : "";
    if (parsed.value.action === "retry") {
      if (!submissionId) throw new Error("A submission is required.");
      const result = await application.review.retryEvaluation(submissionId);
      await startBackgroundJobs(user.id, 3);
      return NextResponse.json(result);
    }
    const recallResult = asRecallResult(parsed.value.recallResult);
    if (!submissionId || !recallResult) {
      throw new Error("A submission and valid evaluation result are required.");
    }
    const result = await application.review.correctRecallResult({
      submissionId,
      recallResult,
    });
    await startBackgroundJobs(user.id, 3);
    return NextResponse.json(result);
  } catch (error) {
    return v2Error(error);
  }
}
