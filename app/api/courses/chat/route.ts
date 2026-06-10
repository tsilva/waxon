import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  buildFallbackCourseToc,
  evaluateCourseChatProgress,
  generateCourseIntakeDecision,
  generateCourseToc,
  streamCourseChatTurn,
  type CourseChatMessage,
  type CourseProgressDecision,
} from "@/app/lib/courseGeneration";
import {
  advanceCourseProgress,
  createCourse,
  getCourse,
  type CourseDetail,
} from "@/app/lib/courseStore";
import { getOpenRouterChatConfig } from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_CHAT_BODY_BYTES = 32 * 1024;
const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_MESSAGE_CHARS = 1_500;
const MAX_TOPIC_CHARS = 800;

function normalizeMessages(value: unknown): CourseChatMessage[] {
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

    return content ? [{ role, content }] : [];
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_COURSE_CHAT_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const messages = normalizeMessages(payload.messages);
  const courseId =
    typeof payload.courseId === "string" ? payload.courseId.trim() : "";

  if (messages.length === 0) {
    return Response.json(
      { ok: false, error: "messages are required." },
      { status: 400 },
    );
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const topic = normalizeBoundedText(latestUserMessage?.content ?? "", {
    field: "topic",
    maxLength: MAX_TOPIC_CHARS,
    required: true,
  });

  if (!topic.ok) {
    return topic.response;
  }

  const openRouterConfig = getOpenRouterChatConfig();

  if (!openRouterConfig.ok) {
    return Response.json(
      { ok: false, error: openRouterConfig.error },
      { status: 500 },
    );
  }

  const user = await getCurrentUser();
  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "courses-chat",
    rules: [
      { name: "minute", max: 8, windowMs: 60_000 },
      { name: "day", max: 100, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        };
        let course: CourseDetail | null = null;
        let progressDecision: CourseProgressDecision | null = null;

        try {
          if (courseId) {
            course = await getCourse(courseId);

            if (!course) {
              throw new Error("Course could not be loaded.");
            }

            progressDecision = await evaluateCourseChatProgress({
              apiKey: openRouterConfig.apiKey,
              model: openRouterConfig.model,
              userId: user.id,
              course,
              messages,
            }).catch(() => ({
              toolCall: "continue_current_milestone" as const,
              reason: "Progress evaluation was unavailable.",
            }));

            if (progressDecision.toolCall === "mark_milestone_done") {
              course = await advanceCourseProgress(course.id);

              if (!course) {
                throw new Error("Course could not be advanced.");
              }

              send("course", { course, progressDecision });
            }
          } else {
            const intakeDecision = await generateCourseIntakeDecision({
              apiKey: openRouterConfig.apiKey,
              model: openRouterConfig.model,
              userId: user.id,
              messages,
            }).catch(() => ({
              action: "create_course" as const,
              topic: topic.value,
              message: "I have enough context to start the course.",
            }));

            if (intakeDecision.action === "clarify") {
              send("delta", { delta: intakeDecision.message });
              send("done", { ok: true, course: null });
              return;
            }

            const toc = await generateCourseToc({
              apiKey: openRouterConfig.apiKey,
              model: openRouterConfig.model,
              topic: intakeDecision.topic,
              userId: user.id,
            }).catch(() => buildFallbackCourseToc(intakeDecision.topic));

            course = await createCourse({
              topic: intakeDecision.topic,
              toc,
            });
            send("course", { course, progressDecision: null });
          }

          await streamCourseChatTurn({
            apiKey: openRouterConfig.apiKey,
            model: openRouterConfig.model,
            userId: user.id,
            course,
            messages,
            progressDecision,
            onTextDelta(delta) {
              send("delta", { delta });
            },
          });

          send("done", { ok: true, course });
        } catch (error) {
          console.info("[waxon] course chat failed", {
            error: error instanceof Error ? error.message : "unknown error",
          });
          send("error", {
            error:
              error instanceof Error
                ? error.message
                : "Could not continue Learn chat.",
          });
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    },
  );
}
