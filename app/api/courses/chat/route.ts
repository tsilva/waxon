import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  buildFallbackCourseToc,
  generateCourseAnswerDecision,
  generateCourseIntakeDecision,
  generateCourseToc,
  streamCourseChatTurn,
  type CourseChatMessage,
} from "@/app/lib/courseGeneration";
import {
  requireCourseMilestoneMastery,
  type CourseProgressDecision,
} from "@/app/lib/courseProgress";
import {
  addCourseConversationCost,
  advanceCourseProgress,
  createCourse,
  getCourse,
  recordCourseChatQuestionAttempt,
  replaceCourseChatMessages,
  updateCourseToc,
  type CourseDetail,
} from "@/app/lib/courseStore";
import {
  appendCourseMessageMetrics,
  stripCourseMessageMetrics,
  type CourseMessageMetrics,
} from "@/app/lib/courseMessageMetrics";
import {
  normalizeCourseQuestionWidgetToolCalls,
  type CourseQuestionWidgetToolCall,
} from "@/app/lib/courseQuestionWidget";
import type { CourseToc } from "@/app/lib/courseContent";
import {
  getOpenRouterChatConfig,
  getOpenRouterEvaluationConfig,
} from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_CHAT_BODY_BYTES = 256 * 1024;
const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_MESSAGE_CHARS = 16_000;
const MAX_STORED_CHAT_MESSAGES = 200;
const MAX_TOPIC_CHARS = 800;

function buildQuestionEvaluationSnippet(input: {
  questionId?: string | null;
  question: string;
  correctAnswer: string;
  score: number;
  justification: string;
}): CourseChatMessage {
  const score = Math.max(0, Math.min(10, Math.round(input.score)));
  const question = input.question.trim();
  const correctAnswer = input.correctAnswer.trim();
  const justification =
    input.justification.trim().replace(/\s+/g, " ") ||
    "Evaluation recorded.";

  return {
    role: "assistant",
    content: [
      `<!-- waxon:evaluation-snippet score=${score} -->`,
      input.questionId
        ? `<!-- waxon:evaluation-question-id ${encodeURIComponent(input.questionId)} -->`
        : "",
      question
        ? `<!-- waxon:evaluation-question ${encodeURIComponent(question)} -->`
        : "",
      correctAnswer
        ? `<!-- waxon:evaluation-correct-answer ${encodeURIComponent(correctAnswer)} -->`
        : "",
      `**Score ${score}/10**`,
      justification,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

type CourseQuestionEvaluationResult = {
  message: CourseChatMessage;
  score: number;
};

type CourseChatLatencyMetrics = {
  answer_decision_ms: number | null;
  time_to_first_delta_ms: number | null;
  chat_stream_ms: number | null;
};

function normalizeStoredMessages(value: unknown): CourseChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(-MAX_STORED_CHAT_MESSAGES).flatMap((item) => {
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

    return content ? [{ role, content, toolCalls }] : [];
  });
}

function shouldEvaluateLatestCourseAnswer(messages: CourseChatMessage[]): boolean {
  const previousAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const previousAssistantText = stripCourseMessageMetrics(
    previousAssistantMessage?.content ?? "",
  )
    .trim()
    .toLowerCase();

  return Boolean(
    previousAssistantText &&
      previousAssistantText !== "what do you want to learn?",
  );
}

function buildProvisionalCourseToc(
  topic: string,
  toc: Partial<CourseToc>,
): CourseToc {
  const fallbackToc = buildFallbackCourseToc(topic);
  const firstPage = toc.pages?.[0] ?? fallbackToc.pages[0];

  return {
    title: toc.title?.trim() || fallbackToc.title,
    description: toc.description?.trim() || fallbackToc.description,
    pages: [firstPage],
  };
}

function buildFallbackCourseTocAfterPartial(
  topic: string,
  provisionalToc: CourseToc | null,
): CourseToc {
  const fallbackToc = buildFallbackCourseToc(topic);

  if (!provisionalToc?.pages[0]) {
    return fallbackToc;
  }

  return {
    title: provisionalToc.title || fallbackToc.title,
    description: provisionalToc.description || fallbackToc.description,
    pages: [provisionalToc.pages[0], ...fallbackToc.pages.slice(1)],
  };
}

function buildDraftCourseDetail(input: {
  userId: string;
  topic: string;
  toc: CourseToc;
}): CourseDetail {
  const now = Date.now();

  return {
    id: "draft-course",
    userId: input.userId,
    topicPrompt: input.topic,
    title: input.toc.title,
    description: input.toc.description,
    toc: input.toc,
    status: "active",
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: input.toc.pages.length,
    generatedPages: 0,
    chatMessageCount: 0,
    conversationCost: 0,
    createdAt: now,
    updatedAt: now,
    pages: [],
    chatMessages: [],
  };
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
  const storedMessages = normalizeStoredMessages(payload.messages);
  const messages = storedMessages
    .map((message) => ({
      ...message,
      content: stripCourseMessageMetrics(message.content),
    }))
    .slice(-MAX_CHAT_MESSAGES);
  const courseId =
    typeof payload.courseId === "string" ? payload.courseId.trim() : "";

  if (messages.length === 0) {
    return Response.json(
      { ok: false, error: "messages are required." },
      { status: 400 },
    );
  }

  const latestUserMessage = [...storedMessages]
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
  const openRouterEvaluationConfig = getOpenRouterEvaluationConfig();

  if (!openRouterConfig.ok) {
    return Response.json(
      { ok: false, error: openRouterConfig.error },
      { status: 500 },
    );
  }

  if (!openRouterEvaluationConfig.ok) {
    return Response.json(
      { ok: false, error: openRouterEvaluationConfig.error },
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
        let assistantContent = "";
        let assistantToolCalls: CourseQuestionWidgetToolCall[] = [];
        let turnCost = 0;
        let intakeDecisionMetrics: CourseMessageMetrics | null = null;
        let answerDecisionMetrics: CourseMessageMetrics | null = null;
        let assistantTurnMetrics: CourseMessageMetrics | null = null;
        const requestStartedAt = Date.now();
        const latencyMetrics: CourseChatLatencyMetrics = {
          answer_decision_ms: null,
          time_to_first_delta_ms: null,
          chat_stream_ms: null,
        };
        const addTurnCost = (cost: number) => {
          if (Number.isFinite(cost) && cost > 0) {
            turnCost += cost;
          }
        };
        let questionEvaluationResult: CourseQuestionEvaluationResult | null =
          null;
        let finalCoursePromise: Promise<CourseDetail> | null = null;

        try {
          if (courseId) {
            send("status", { status: "Checking answer" });
            course = await getCourse(courseId);

            if (!course) {
              throw new Error("Course could not be loaded.");
            }

            if (shouldEvaluateLatestCourseAnswer(messages)) {
              send("evaluation_pending", {});
              const answerDecisionStartedAt = Date.now();
              const answerDecision = await generateCourseAnswerDecision({
                apiKey: openRouterEvaluationConfig.apiKey,
                model: openRouterEvaluationConfig.model,
                userId: user.id,
                course,
                messages,
                onCost: addTurnCost,
                onMetrics(metrics) {
                  answerDecisionMetrics = metrics;
                },
              }).catch(() => ({
                questionAttempt: {
                  toolCall: "skip_course_question_attempt" as const,
                  reason: "Course answer decision was unavailable.",
                },
                progressDecision: {
                  toolCall: "continue_current_milestone" as const,
                  reason: "Course answer decision was unavailable.",
                },
              }));
              latencyMetrics.answer_decision_ms =
                Date.now() - answerDecisionStartedAt;
              progressDecision = answerDecision.progressDecision;

              if (
                answerDecision.questionAttempt.toolCall !==
                "record_course_question_attempt"
              ) {
                send("evaluation_skipped", {
                  reason: answerDecision.questionAttempt.reason,
                });
              } else {
                const questionAttempt = answerDecision.questionAttempt;
                const recordedAttempt = await recordCourseChatQuestionAttempt({
                  course,
                  question: questionAttempt.question,
                  answer: questionAttempt.answer,
                  answerSummary: questionAttempt.answerSummary,
                  conciseAnswer: questionAttempt.conciseAnswer,
                  correctAnswer: questionAttempt.correctAnswer,
                  justification: questionAttempt.justification,
                  score: questionAttempt.score,
                  submittedAt: Date.now(),
                });
                const evaluationSnippet = buildQuestionEvaluationSnippet({
                  questionId: recordedAttempt?.questionId ?? null,
                  question: questionAttempt.question,
                  correctAnswer: questionAttempt.correctAnswer,
                  score: questionAttempt.score,
                  justification: questionAttempt.justification,
                });
                const evaluationSnippetWithMetrics = {
                  ...evaluationSnippet,
                  content: appendCourseMessageMetrics(
                    evaluationSnippet.content,
                    answerDecisionMetrics,
                  ),
                };
                questionEvaluationResult = {
                  message: evaluationSnippetWithMetrics,
                  score: questionAttempt.score,
                };
                send("evaluation", {
                  score: questionAttempt.score,
                  justification: questionAttempt.justification,
                  content: evaluationSnippetWithMetrics.content,
                });
              }
            } else {
              progressDecision = {
                toolCall: "continue_current_milestone",
                reason: "No learner-facing question was answered.",
              };
            }

            const checkedProgressDecision = requireCourseMilestoneMastery({
              progressDecision:
                progressDecision ?? {
                  toolCall: "continue_current_milestone",
                  reason: "No learner-facing question was answered.",
                },
              evaluationScore: questionEvaluationResult?.score ?? null,
            });
            progressDecision = checkedProgressDecision;

            if (checkedProgressDecision.toolCall === "mark_milestone_done") {
              course = await advanceCourseProgress(course.id);

              if (!course) {
                throw new Error("Course could not be advanced.");
              }

              send("course", { course, progressDecision });
            }
          } else {
            send("status", { status: "Thinking..." });
            const intakeDecision = await generateCourseIntakeDecision({
              apiKey: openRouterConfig.apiKey,
              model: openRouterConfig.model,
              userId: user.id,
              messages,
              onCost: addTurnCost,
              onMetrics(metrics) {
                intakeDecisionMetrics = metrics;
              },
            }).catch(() => ({
              action: "create_course" as const,
              topic: topic.value,
              message: "I have enough context to start the course.",
            }));

            if (intakeDecision.action === "clarify") {
              send("status", { status: "Writing response" });
              latencyMetrics.time_to_first_delta_ms =
                Date.now() - requestStartedAt;
              latencyMetrics.chat_stream_ms = 0;
              send("delta", { delta: intakeDecision.message });
              send("done", {
                ok: true,
                course: null,
                turnCost,
                responseMetrics: intakeDecisionMetrics,
                latencyMetrics,
              });
              return;
            }

            send("status", { status: "Generating TOC" });
            let provisionalToc: CourseToc | null = null;
            let createdFromCompleteToc = false;
            let firstLessonCourseResolved = false;
            let resolveFirstLessonCourse: (course: CourseDetail) => void =
              () => {};
            let courseCreationPromise: Promise<CourseDetail> | null = null;
            const firstLessonCoursePromise = new Promise<CourseDetail>(
              (resolve) => {
                resolveFirstLessonCourse = resolve;
              },
            );
            const startFirstLessonFromToc = (toc: CourseToc) => {
              if (firstLessonCourseResolved) {
                return;
              }

              firstLessonCourseResolved = true;
              resolveFirstLessonCourse(
                buildDraftCourseDetail({
                  userId: user.id,
                  topic: intakeDecision.topic,
                  toc,
                }),
              );
            };
            const ensureCourseCreated = (
              toc: CourseToc,
              options: { complete: boolean },
            ) => {
              if (!courseCreationPromise) {
                provisionalToc = toc;
                createdFromCompleteToc = options.complete;
                courseCreationPromise = createCourse({
                  topic: intakeDecision.topic,
                  toc,
                }).then(
                  (createdCourse) => {
                    send("course", {
                      course: createdCourse,
                      progressDecision: null,
                    });
                    return createdCourse;
                  },
                  (error: unknown) => {
                    throw error;
                  },
                );
                void courseCreationPromise.catch(() => {});
              }

              return courseCreationPromise;
            };
            const tocPromise = generateCourseToc({
              apiKey: openRouterConfig.apiKey,
              model: openRouterConfig.model,
              topic: intakeDecision.topic,
              userId: user.id,
              onCost: addTurnCost,
              onPartialToc: (partialToc) => {
                send("toc", { toc: partialToc, complete: false });

                if (partialToc.pages.length > 0) {
                  const nextProvisionalToc = buildProvisionalCourseToc(
                    intakeDecision.topic,
                    partialToc,
                  );
                  provisionalToc = nextProvisionalToc;
                  startFirstLessonFromToc(nextProvisionalToc);
                  ensureCourseCreated(nextProvisionalToc, { complete: false });
                }
              },
            }).catch(() => {
              return buildFallbackCourseTocAfterPartial(
                intakeDecision.topic,
                provisionalToc,
              );
            });
            finalCoursePromise = tocPromise.then(async (toc) => {
              send("toc", { toc, complete: true });
              startFirstLessonFromToc(toc);
              const createdCourse = await ensureCourseCreated(toc, {
                complete: true,
              });

              if (createdFromCompleteToc) {
                return createdCourse;
              }

              const updatedCourse = await updateCourseToc({
                courseId: createdCourse.id,
                toc,
              });
              send("course", { course: updatedCourse, progressDecision: null });
              return updatedCourse;
            });
            void finalCoursePromise.catch(() => {});
            course = await firstLessonCoursePromise;
          }

          send("status", { status: "Writing lesson" });
          const chatStreamStartedAt = Date.now();
          const assistantTurn = await streamCourseChatTurn({
            apiKey: openRouterConfig.apiKey,
            model: openRouterConfig.model,
            userId: user.id,
            course,
            messages,
            progressDecision,
            onCost: addTurnCost,
            onMetrics(metrics) {
              assistantTurnMetrics = metrics;
            },
            onTextDelta(delta) {
              assistantContent += delta;
              latencyMetrics.time_to_first_delta_ms ??=
                Date.now() - requestStartedAt;
              send("delta", { delta });
            },
          });
          assistantContent = assistantTurn.content;
          assistantToolCalls = assistantTurn.toolCalls;
          latencyMetrics.chat_stream_ms = Date.now() - chatStreamStartedAt;

          if (finalCoursePromise) {
            course = await finalCoursePromise;
          }

          const chatMessages = await replaceCourseChatMessages({
            courseId: course.id,
            messages: [
              ...storedMessages,
              ...(questionEvaluationResult
                ? [questionEvaluationResult.message]
                : []),
              {
                role: "assistant",
                content: appendCourseMessageMetrics(
                  assistantContent,
                  assistantTurnMetrics,
                ),
                toolCalls: assistantToolCalls,
              },
            ],
          });
          await addCourseConversationCost({
            courseId: course.id,
            cost: turnCost,
          });
          const updatedCourse = (await getCourse(course.id)) ?? course;

          send("done", {
            ok: true,
            course: updatedCourse,
            chatMessages,
            turnCost,
            latencyMetrics,
          });
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
