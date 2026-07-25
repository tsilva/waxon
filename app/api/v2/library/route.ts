import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  acceptQuestion,
  acceptQuestions,
  addConceptToQuestion,
  createDirectQuestion,
  editQuestion,
  listLibrary,
  mergeQuestions,
  mutateQuestionLifecycle,
  runPendingJobs,
  splitQuestion,
} from "@/app/lib/v2/service";
import {
  asAnswerMode,
  isRecord,
  v2Error,
} from "@/app/lib/v2/http";
import type { V2Lifecycle } from "@/app/lib/v2/types";

const LIFECYCLES = new Set<V2Lifecycle>([
  "draft",
  "new",
  "learning",
  "review",
  "paused",
  "archived",
  "suspended",
  "trash",
  "superseded",
]);

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    after(() => runPendingJobs({ userId: user.id, limit: 3 }));
    const url = new URL(request.url);
    const requestedLifecycle = url.searchParams.get("lifecycle");
    const lifecycle =
      requestedLifecycle && LIFECYCLES.has(requestedLifecycle as V2Lifecycle)
        ? (requestedLifecycle as V2Lifecycle)
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
  const parsed = await readJsonBodyWithLimit(request, 256 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-direct-capture",
      rules: [{ name: "hour", max: 60, windowMs: 60 * 60_000 }],
    });
    if (limited) {
      return limited;
    }
    if (!isRecord(parsed.value)) {
      throw new Error("A question payload is required.");
    }
    const prompt =
      typeof parsed.value.prompt === "string" ? parsed.value.prompt : "";
    const referenceAnswer =
      typeof parsed.value.referenceAnswer === "string"
        ? parsed.value.referenceAnswer
        : "";
    if (!prompt.trim() || !referenceAnswer.trim()) {
      throw new Error("Question and reference answer are required.");
    }
    const result = await createDirectQuestion({
      userId: user.id,
      idempotencyKey:
        typeof parsed.value.idempotencyKey === "string"
          ? parsed.value.idempotencyKey.slice(0, 200)
          : randomUUID(),
      prompt: prompt.slice(0, 16_384),
      referenceAnswer: referenceAnswer.slice(0, 65_536),
      displayAnswer:
        typeof parsed.value.displayAnswer === "string"
          ? parsed.value.displayAnswer.slice(0, 8_000)
          : undefined,
      target:
        typeof parsed.value.target === "string"
          ? parsed.value.target.slice(0, 4_000)
          : undefined,
      answerMode: asAnswerMode(parsed.value.answerMode),
    });
    after(() => runPendingJobs({ userId: user.id, limit: 3 }));
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return v2Error(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 512 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    if (!isRecord(parsed.value) || typeof parsed.value.action !== "string") {
      throw new Error("An action is required.");
    }
    const action = parsed.value.action;
    const questionId =
      typeof parsed.value.questionId === "string"
        ? parsed.value.questionId
        : "";

    if (action === "batch-accept") {
      const questionIds = Array.isArray(parsed.value.questionIds)
        ? parsed.value.questionIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const accepted = await acceptQuestions({
        userId: user.id,
        questionIds,
      });
      after(() => runPendingJobs({ userId: user.id, limit: 6 }));
      return NextResponse.json({ ok: true, accepted });
    }
    if (
      action === "pause" ||
      action === "archive" ||
      action === "trash" ||
      action === "restore" ||
      action === "flag"
    ) {
      await mutateQuestionLifecycle({ userId: user.id, questionId, action });
    } else if (action === "accept") {
      await acceptQuestion({ userId: user.id, questionId });
    } else if (action === "merge") {
      await mergeQuestions({
        userId: user.id,
        canonicalQuestionId:
          typeof parsed.value.canonicalQuestionId === "string"
            ? parsed.value.canonicalQuestionId
            : "",
        redundantQuestionId:
          typeof parsed.value.redundantQuestionId === "string"
            ? parsed.value.redundantQuestionId
            : "",
      });
    } else if (action === "concept") {
      await addConceptToQuestion({
        userId: user.id,
        questionId,
        name:
          typeof parsed.value.name === "string" ? parsed.value.name : "",
      });
    } else if (action === "edit") {
      const prompt =
        typeof parsed.value.prompt === "string" ? parsed.value.prompt : "";
      const referenceAnswer =
        typeof parsed.value.referenceAnswer === "string"
          ? parsed.value.referenceAnswer
          : "";
      const target =
        typeof parsed.value.target === "string" ? parsed.value.target : "";
      if (!prompt.trim() || !referenceAnswer.trim() || !target.trim()) {
        throw new Error(
          "Question, reference answer, and recall target are required.",
        );
      }
      await editQuestion({
        userId: user.id,
        questionId,
        prompt: prompt.slice(0, 16_384),
        referenceAnswer: referenceAnswer.slice(0, 65_536),
        displayAnswer:
          typeof parsed.value.displayAnswer === "string"
            ? parsed.value.displayAnswer.slice(0, 8_000)
            : undefined,
        target: target.slice(0, 4_000),
        answerMode: asAnswerMode(parsed.value.answerMode),
      });
    } else if (action === "split") {
      if (!Array.isArray(parsed.value.children)) {
        throw new Error("Split children are required.");
      }
      const children = parsed.value.children.flatMap((child) => {
        if (!isRecord(child)) {
          return [];
        }
        const prompt = typeof child.prompt === "string" ? child.prompt : "";
        const referenceAnswer =
          typeof child.referenceAnswer === "string"
            ? child.referenceAnswer
            : "";
        const target = typeof child.target === "string" ? child.target : prompt;
        return prompt.trim() && referenceAnswer.trim()
          ? [
              {
                prompt: prompt.slice(0, 16_384),
                referenceAnswer: referenceAnswer.slice(0, 65_536),
                displayAnswer:
                  typeof child.displayAnswer === "string"
                    ? child.displayAnswer.slice(0, 8_000)
                    : undefined,
                target: target.slice(0, 4_000),
                answerMode: asAnswerMode(child.answerMode),
              },
            ]
          : [];
      });
      await splitQuestion({ userId: user.id, questionId, children });
    } else {
      throw new Error("This Library action is not allowed.");
    }
    after(() => runPendingJobs({ userId: user.id, limit: 6 }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return v2Error(error);
  }
}
