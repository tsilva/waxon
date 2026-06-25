import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  buildCourseAnswerContinuationModelRequest,
  buildCourseChatTurnModelRequest,
  shouldUseCourseAnswerContinuationRequest,
  type CourseChatMessage,
} from "@/app/lib/courseGeneration";
import { getCourse } from "@/app/lib/courseStore";
import type { CourseMessageMetrics } from "@/app/lib/courseMessageMetrics";
import {
  normalizeCourseQuestionWidgetToolCalls,
  type CourseQuestionWidgetAnswerDetails,
} from "@/app/lib/courseQuestionWidget";
import {
  DEFAULT_OPENROUTER_LEARN_MODEL,
  getOpenRouterLearnModel,
} from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_PREVIEW_BODY_BYTES = 256 * 1024;
const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_MESSAGE_CHARS = 16_000;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedString(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function normalizeCourseMessageMetrics(
  value: unknown,
): CourseMessageMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return {
    cost: finiteNumber(record.cost),
    promptTokens: finiteNumber(record.promptTokens),
    cachedPromptTokens: finiteNumber(record.cachedPromptTokens),
    uncachedPromptTokens: finiteNumber(record.uncachedPromptTokens),
    cacheWriteTokens: finiteNumber(record.cacheWriteTokens),
    cacheHitPercent: finiteNumber(record.cacheHitPercent),
    outputTokens: finiteNumber(record.outputTokens),
    totalTokens: finiteNumber(record.totalTokens),
    latencyMs: finiteNumber(record.latencyMs),
    tokensPerSecond: finiteNumber(record.tokensPerSecond),
    contextWindowTokens: finiteNumber(record.contextWindowTokens),
    contextPercent: finiteNumber(record.contextPercent),
  };
}

function normalizeCourseChatEvaluation(
  value: unknown,
): CourseChatMessage["evaluation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const question = normalizedString(record.question, 1_200);
  const feedback = normalizedString(record.feedback, 1_200);
  const score = finiteNumber(record.score);

  if (!question || !feedback || score === null) {
    return null;
  }

  return {
    questionId: normalizedString(record.questionId, 80) || null,
    question,
    correctAnswer: normalizedString(record.correctAnswer, 1_200) || null,
    score: Math.max(0, Math.min(10, Math.round(score))),
    feedback,
  };
}

function normalizeCourseWidgetAnswer(
  value: unknown,
): CourseQuestionWidgetAnswerDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const answer = normalizedString(record.answer, 4_000);

  if (!answer) {
    return null;
  }

  return {
    question: normalizedString(record.question, 1_200) || null,
    widgetId: normalizedString(record.widgetId, 80) || null,
    answer,
  };
}

function normalizeStoredMessages(value: unknown): CourseChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(-MAX_CHAT_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const role: CourseChatMessage["role"] =
      record.role === "assistant" ? "assistant" : "user";
    const content =
      typeof record.content === "string"
        ? record.content.trim().slice(0, MAX_CHAT_MESSAGE_CHARS)
        : "";

    const toolCalls =
      role === "assistant"
        ? normalizeCourseQuestionWidgetToolCalls(record.toolCalls)
        : [];
    const metrics = normalizeCourseMessageMetrics(record.metrics);
    const evaluation =
      role === "assistant"
        ? normalizeCourseChatEvaluation(record.evaluation)
        : null;
    const widgetAnswer =
      role === "user" ? normalizeCourseWidgetAnswer(record.widgetAnswer) : null;

    return content
      ? [{ role, content, toolCalls, metrics, evaluation, widgetAnswer }]
      : [];
  });
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(
    request,
    MAX_PROMPT_PREVIEW_BODY_BYTES,
  );

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const courseId =
    typeof payload.courseId === "string" ? payload.courseId.trim() : "";
  const messages = normalizeStoredMessages(payload.messages);

  if (!courseId) {
    return Response.json(
      { ok: false, error: "courseId is required." },
      { status: 400 },
    );
  }

  if (messages.length === 0) {
    return Response.json(
      { ok: false, error: "messages are required." },
      { status: 400 },
    );
  }

  const user = await getCurrentUser();
  const course = await getCourse(courseId);

  if (!course) {
    return Response.json(
      { ok: false, error: "Course could not be loaded." },
      { status: 404 },
    );
  }

  const model = getOpenRouterLearnModel() ?? DEFAULT_OPENROUTER_LEARN_MODEL;
  const requestPreview = shouldUseCourseAnswerContinuationRequest(messages)
    ? buildCourseAnswerContinuationModelRequest({
        userId: user.id,
        course,
        messages,
        model,
      })
    : buildCourseChatTurnModelRequest({
        userId: user.id,
        course,
        messages,
        progressDecision: null,
        model,
      });

  return Response.json({
    ok: true,
    modelRequest: {
      kind: requestPreview.kind,
      model: requestPreview.model,
      pageTitle: requestPreview.pageTitle,
      nextPageTitle:
        "nextPageTitle" in requestPreview ? requestPreview.nextPageTitle : null,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      requestBody: requestPreview.requestBody,
    },
  });
}
