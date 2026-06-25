import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  buildCourseAnswerContinuationModelRequest,
  buildCourseChatTurnModelRequest,
  shouldUseCourseAnswerContinuationRequest,
  type CourseChatMessage,
} from "@/app/lib/courseGeneration";
import { getCourse, type CourseChatMessageRecord } from "@/app/lib/courseStore";
import { courseQuestionWidgetsFromToolCalls } from "@/app/lib/courseQuestionWidget";
import {
  DEFAULT_OPENROUTER_LEARN_MODEL,
  getOpenRouterLearnModel,
} from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_PREVIEW_BODY_BYTES = 8 * 1024;
const MAX_CHAT_MESSAGES = 20;
const NEXT_INPUT_PLACEHOLDER = "<next learner input>";

function storedCourseChatMessageToPromptMessage(
  message: CourseChatMessageRecord,
): CourseChatMessage {
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.role === "assistant" ? message.toolCalls : [],
    metrics: message.metrics,
    evaluation: message.role === "assistant" ? message.evaluation : null,
    widgetAnswer: message.role === "user" ? message.widgetAnswer : null,
  };
}

function findLatestUnansweredWidget(messages: CourseChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "assistant") {
      continue;
    }

    const widgets = courseQuestionWidgetsFromToolCalls(message.toolCalls);

    for (const widget of widgets.toReversed()) {
      const hasLaterAnswer = messages
        .slice(index + 1)
        .some(
          (laterMessage) =>
            laterMessage.role === "user" &&
            laterMessage.widgetAnswer?.widgetId === widget.id,
        );

      if (!hasLaterAnswer) {
        return widget;
      }
    }
  }

  return null;
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

  if (!courseId) {
    return Response.json(
      { ok: false, error: "courseId is required." },
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
  const storedMessages = course.chatMessages.map(
    storedCourseChatMessageToPromptMessage,
  );
  const latestUnansweredWidget = findLatestUnansweredWidget(storedMessages);
  const nextUserMessage: CourseChatMessage = {
    role: "user",
    content: NEXT_INPUT_PLACEHOLDER,
    widgetAnswer: latestUnansweredWidget
      ? {
          question: latestUnansweredWidget.question,
          widgetId: latestUnansweredWidget.id,
          answer: NEXT_INPUT_PLACEHOLDER,
        }
      : null,
  };
  const messages = [...storedMessages, nextUserMessage].slice(-MAX_CHAT_MESSAGES);
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
