import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  asGrade,
  isRecord,
  v2Error,
} from "@/app/lib/v2/http";
import {
  applyLearnerGrade,
  getEvaluationForSubmission,
} from "@/app/lib/v2/service";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    const submissionId = new URL(request.url).searchParams.get("submissionId");
    if (!submissionId) {
      throw new Error("submissionId is required.");
    }
    return NextResponse.json(
      await getEvaluationForSubmission(user.id, submissionId),
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
    if (!isRecord(parsed.value)) {
      throw new Error("A grade payload is required.");
    }
    const submissionId =
      typeof parsed.value.submissionId === "string"
        ? parsed.value.submissionId
        : "";
    const grade = asGrade(parsed.value.grade);
    if (!submissionId || !grade) {
      throw new Error("A submission and valid grade are required.");
    }
    const result = await applyLearnerGrade({
      userId: user.id,
      submissionId,
      grade,
    });
    await startBackgroundJobs(user.id, 3);
    return NextResponse.json(result);
  } catch (error) {
    return v2Error(error);
  }
}
