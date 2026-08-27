import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { consumeUserRateLimit, readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";
import { waxonApplication } from "@/app/lib/v2/application";
import type { V2QuestionLifecycle } from "@/app/lib/v2/types";

const LIFECYCLES = new Set<V2QuestionLifecycle>([
  "active",
  "flagged",
  "archived",
]);

async function startEmbeddingJobsBestEffort(userId: string) {
  try {
    await startBackgroundJobs(userId, 4);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { surface: "library", stage: "start-question-embedding-jobs" },
    });
  }
}

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    const url = new URL(request.url);
    const requested = url.searchParams.get("lifecycle");
    const lifecycle =
      requested && LIFECYCLES.has(requested as V2QuestionLifecycle)
        ? (requested as V2QuestionLifecycle)
        : "all";
    return NextResponse.json(
      await application.questionBank.list({
        lifecycle,
        search: url.searchParams.get("search") ?? "",
      }),
    );
  } catch (error) {
    return v2Error(error);
  }
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 96 * 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-question-add",
      rules: [{ name: "hour", max: 120, windowMs: 60 * 60_000 }],
    });
    if (limited) return limited;
    if (!isRecord(parsed.value)) throw new Error("A question payload is required.");
    const prompt = typeof parsed.value.prompt === "string" ? parsed.value.prompt : "";
    const referenceAnswer =
      typeof parsed.value.referenceAnswer === "string"
        ? parsed.value.referenceAnswer
        : "";
    const result = await application.questionBank.create({
      idempotencyKey:
        typeof parsed.value.idempotencyKey === "string"
          ? parsed.value.idempotencyKey.slice(0, 200)
          : randomUUID(),
      prompt,
      referenceAnswer,
    });
    if (result.status === "created") {
      await startEmbeddingJobsBestEffort(user.id);
    }
    return NextResponse.json({ ok: true, ...result }, { status: result.status === "created" ? 201 : 200 });
  } catch (error) {
    return v2Error(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 96 * 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const user = await getCurrentUser();
    const application = waxonApplication.forLearner(user.id);
    if (!isRecord(parsed.value) || typeof parsed.value.action !== "string") {
      throw new Error("An action is required.");
    }
    const questionId =
      typeof parsed.value.questionId === "string" ? parsed.value.questionId : "";
    if (!questionId) throw new Error("A question is required.");
    let replacement:
      | Awaited<ReturnType<typeof application.questionBank.replace>>
      | undefined;
    if (parsed.value.action === "archive") {
      await application.questionBank.archive(questionId);
    } else if (parsed.value.action === "restore") {
      await application.questionBank.restore(questionId);
    } else if (parsed.value.action === "flag") {
      const flagged = await application.questionBank.flag({
        questionId,
        reasons: parsed.value.reasons,
        detail: parsed.value.detail,
      });
      return NextResponse.json({ ok: true, ...flagged });
    } else if (parsed.value.action === "replace") {
      replacement = await application.questionBank.replace({
        questionId,
        prompt: typeof parsed.value.prompt === "string" ? parsed.value.prompt : "",
        referenceAnswer:
          typeof parsed.value.referenceAnswer === "string"
            ? parsed.value.referenceAnswer
            : "",
      });
      if (replacement.status === "replaced") {
        await startEmbeddingJobsBestEffort(user.id);
      }
    } else {
      throw new Error("This Library action is not allowed.");
    }
    return NextResponse.json({ ok: true, ...replacement });
  } catch (error) {
    return v2Error(error);
  }
}
