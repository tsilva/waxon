import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { consumeUserRateLimit, readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { asAnswerMode, isRecord, v2Error } from "@/app/lib/v2/http";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";
import {
  createDirectQuestion,
  editQuestion,
  listLibrary,
  mutateQuestionLifecycle,
} from "@/app/lib/v2/service";
import type { V2Lifecycle } from "@/app/lib/v2/types";

const LIFECYCLES = new Set<V2Lifecycle>([
  "new",
  "learning",
  "review",
  "flagged",
  "paused",
  "archived",
  "trash",
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
    const url = new URL(request.url);
    const requested = url.searchParams.get("lifecycle");
    const lifecycle =
      requested && LIFECYCLES.has(requested as V2Lifecycle)
        ? (requested as V2Lifecycle)
        : "all";
    return NextResponse.json(
      await listLibrary({
        userId: user.id,
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
    const result = await createDirectQuestion({
      userId: user.id,
      idempotencyKey:
        typeof parsed.value.idempotencyKey === "string"
          ? parsed.value.idempotencyKey.slice(0, 200)
          : randomUUID(),
      prompt,
      referenceAnswer,
      answerMode: asAnswerMode(parsed.value.answerMode),
      importance:
        typeof parsed.value.importance === "number" ? parsed.value.importance : undefined,
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
    if (!isRecord(parsed.value) || typeof parsed.value.action !== "string") {
      throw new Error("An action is required.");
    }
    const questionId =
      typeof parsed.value.questionId === "string" ? parsed.value.questionId : "";
    if (!questionId) throw new Error("A question is required.");
    if (["pause", "archive", "trash", "restore"].includes(parsed.value.action)) {
      await mutateQuestionLifecycle({
        userId: user.id,
        questionId,
        action: parsed.value.action as "pause" | "archive" | "trash" | "restore",
      });
    } else if (parsed.value.action === "edit") {
      await editQuestion({
        userId: user.id,
        questionId,
        prompt: typeof parsed.value.prompt === "string" ? parsed.value.prompt : "",
        referenceAnswer:
          typeof parsed.value.referenceAnswer === "string"
            ? parsed.value.referenceAnswer
            : "",
        answerMode: asAnswerMode(parsed.value.answerMode),
        importance:
          typeof parsed.value.importance === "number"
            ? parsed.value.importance
            : undefined,
      });
      await startEmbeddingJobsBestEffort(user.id);
    } else {
      throw new Error("This Library action is not allowed.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return v2Error(error);
  }
}
