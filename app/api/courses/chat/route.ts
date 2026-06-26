import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  buildFallbackCourseToc,
  courseAnswerContinuationRetryInstructionForError,
  generateCourseIntakeDecision,
  generateCourseToc,
  shouldUseCourseAnswerContinuationRequest,
  storedCourseChatMessageToPromptMessage,
  streamCourseAnswerContinuation,
  streamCourseChatTurn,
  type CourseAnswerDecisionToolResult,
  type CourseChatMessage,
} from "@/app/lib/courseGeneration";
import type { CourseProgressDecision } from "@/app/lib/courseProgress";
import {
  appendCourseChatMessages,
  addCourseConversationCost,
  advanceCourseProgress,
  createCourse,
  getCourse,
  recordCourseChatQuestionAttempt,
  updateCourseToc,
  type CourseDetail,
} from "@/app/lib/courseStore";
import type { CourseMessageMetrics } from "@/app/lib/courseMessageMetrics";
import {
  courseTocToolCallFromToc,
  normalizeCourseQuestionWidgetAnswerDetails,
  type CourseAnswerDecisionToolCall,
  type CourseQuestionWidgetToolCall,
} from "@/app/lib/courseQuestionWidget";
import type { CourseToc } from "@/app/lib/courseContent";
import { getOpenRouterLearnConfig } from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_CHAT_BODY_BYTES = 32 * 1024;
const MAX_CHAT_MESSAGE_CHARS = 16_000;
const MAX_TOPIC_CHARS = 800;

function buildQuestionEvaluationMessage(input: {
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
    content: `Score ${score}/10\n\n${justification}`,
    evaluation: {
      questionId: input.questionId ?? null,
      question: question || "Course question",
      correctAnswer: correctAnswer || null,
      score,
      feedback: justification,
    },
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
  rollback_count?: number;
};

function normalizeIncomingUserMessage(
  payload: Record<string, unknown>,
  maxLength: number,
):
  | { ok: true; message: CourseChatMessage }
  | { ok: false; response: Response } {
  const messageValue = payload.message;
  const messageRecord =
    messageValue && typeof messageValue === "object" && !Array.isArray(messageValue)
      ? (messageValue as Record<string, unknown>)
      : {};
  const content = normalizeBoundedText(messageRecord.content, {
    field: "message.content",
    maxLength,
    required: true,
  });

  if (!content.ok) {
    return content;
  }

  return {
    ok: true,
    message: {
      role: "user",
      content: content.value,
      widgetAnswer: normalizeCourseQuestionWidgetAnswerDetails(
        messageRecord.widgetAnswer,
      ),
    },
  };
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

function buildCourseTocGeneratedMessage(course: CourseDetail): CourseChatMessage {
  return {
    role: "assistant",
    content: "Generated the course table of contents.",
    toolCalls: [
      courseTocToolCallFromToc(
        {
          topic: course.topicPrompt,
          toc: course.toc,
        },
        `course-toc-${course.id}`.slice(0, 80),
      ),
    ],
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
  const courseId =
    typeof payload.courseId === "string" ? payload.courseId.trim() : "";
  const incomingUserMessage = normalizeIncomingUserMessage(
    payload,
    courseId ? MAX_CHAT_MESSAGE_CHARS : MAX_TOPIC_CHARS,
  );

  if (!incomingUserMessage.ok) {
    return incomingUserMessage.response;
  }

  const userMessage = incomingUserMessage.message;
  let conversationMessages: CourseChatMessage[] = [userMessage];
  let messages = conversationMessages;

  if (!courseId) {
    const topic = normalizeBoundedText(userMessage.content, {
      field: "topic",
      maxLength: MAX_TOPIC_CHARS,
      required: true,
    });

    if (!topic.ok) {
      return topic.response;
    }
  }

  const openRouterConfig = getOpenRouterLearnConfig();

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
        let assistantContent = "";
        let assistantToolCalls: CourseQuestionWidgetToolCall[] = [];
        let answerDecisionToolCall: CourseAnswerDecisionToolCall | null = null;
        let turnCost = 0;
        let intakeDecisionMetrics: CourseMessageMetrics | null = null;
        let assistantTurnMetrics: CourseMessageMetrics | null = null;
        let sentQuestionWidgetPending = false;
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
        const applyAnswerDecision = async (
          answerDecision: CourseAnswerDecisionToolResult,
          metrics: CourseMessageMetrics | null,
        ) => {
          if (!course) {
            throw new Error("Course could not be loaded.");
          }

          progressDecision = answerDecision.progressDecision;

          if (
            answerDecision.questionAttempt.toolCall !==
            "record_course_question_attempt"
          ) {
            send("evaluation_skipped", {
              reason: answerDecision.questionAttempt.reason,
            });
            return;
          }

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
          const evaluationMessage = buildQuestionEvaluationMessage({
            questionId: recordedAttempt?.questionId ?? null,
            question: questionAttempt.question,
            correctAnswer: questionAttempt.correctAnswer,
            score: questionAttempt.score,
            justification: questionAttempt.justification,
          });
          questionEvaluationResult = {
            message: {
              ...evaluationMessage,
              metrics,
            },
            score: questionAttempt.score,
          };
          send("evaluation", {
            score: questionAttempt.score,
            justification: questionAttempt.justification,
            content: evaluationMessage.content,
            evaluation: evaluationMessage.evaluation,
            metrics,
          });

          if (answerDecision.progressDecision.toolCall === "mark_milestone_done") {
            course = await advanceCourseProgress(course.id);

            if (!course) {
              throw new Error("Course could not be advanced.");
            }

            send("course", { course, progressDecision: answerDecision.progressDecision });
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

            conversationMessages = [
              ...course.chatMessages.map(storedCourseChatMessageToPromptMessage),
              userMessage,
            ];
            messages = conversationMessages;

            if (shouldUseCourseAnswerContinuationRequest(messages)) {
              send("evaluation_pending", {});
              const runSingleStreamContinuation = async (
                retryInstruction: string | null = null,
              ) => {
                assistantContent = "";
                assistantToolCalls = [];
                answerDecisionToolCall = null;
                sentQuestionWidgetPending = false;
                questionEvaluationResult = null;
                assistantTurnMetrics = null;
                const activeCourse = course;

                if (!activeCourse) {
                  throw new Error("Course could not be loaded.");
                }

                const chatStreamStartedAt = Date.now();
                let singleStreamAnswerDecision: CourseAnswerDecisionToolResult | null =
                  null;
                const assistantTurn = await streamCourseAnswerContinuation({
                  apiKey: openRouterConfig.apiKey,
                  model: openRouterConfig.model,
                  userId: user.id,
                  course: activeCourse,
                  messages,
                  retryInstruction,
                  onCost: addTurnCost,
                  onMetrics(metrics) {
                    assistantTurnMetrics = metrics;
                  },
                  async onAnswerDecision(answerDecision) {
                    if (singleStreamAnswerDecision) {
                      return;
                    }

                    latencyMetrics.answer_decision_ms ??=
                      Date.now() - requestStartedAt;
                    singleStreamAnswerDecision = answerDecision;
                  },
                  onTextDelta(delta) {
                    assistantContent += delta;
                    latencyMetrics.time_to_first_delta_ms ??=
                      Date.now() - requestStartedAt;
                    send("delta", { delta });
                  },
                  onQuestionWidgetToolDelta() {
                    if (sentQuestionWidgetPending) {
                      return;
                    }

                    sentQuestionWidgetPending = true;
                    send("question_widget_pending", {});
                  },
                });
                assistantContent = assistantTurn.content;
                assistantToolCalls = assistantTurn.toolCalls;
                answerDecisionToolCall = assistantTurn.answerDecisionToolCall;
                await applyAnswerDecision(
                  singleStreamAnswerDecision ?? assistantTurn.answerDecision,
                  null,
                );
                latencyMetrics.chat_stream_ms =
                  Date.now() - chatStreamStartedAt;
              };
              let singleStreamSucceeded = false;

              try {
                await runSingleStreamContinuation();
                singleStreamSucceeded = true;
              } catch (error) {
                latencyMetrics.rollback_count = 1;
                const reason =
                  error instanceof Error
                    ? error.message
                    : "Single-stream Learn continuation failed.";

                send("rollback", {
                  checkpoint: "after_user_answer",
                  reason,
                  retry: true,
                });

                try {
                  await runSingleStreamContinuation(
                    courseAnswerContinuationRetryInstructionForError(error),
                  );
                  singleStreamSucceeded = true;
                } catch (retryError) {
                  send("rollback", {
                    checkpoint: "after_user_answer",
                    reason:
                      retryError instanceof Error
                        ? retryError.message
                        : "Single-stream Learn continuation retry failed.",
                    retry: false,
                  });
                  throw retryError;
                }
              }

              if (singleStreamSucceeded) {
                if (assistantToolCalls.length > 0) {
                  send("question_widget", { toolCalls: assistantToolCalls });
                }

                if (finalCoursePromise) {
                  course = await finalCoursePromise;
                }

                const evaluationResult =
                  questionEvaluationResult as CourseQuestionEvaluationResult | null;
                const tocGenerationMessages = finalCoursePromise
                  ? [buildCourseTocGeneratedMessage(course)]
                  : [];
                const chatMessages = await appendCourseChatMessages({
                  courseId: course.id,
                  messages: [
                    userMessage,
                    ...tocGenerationMessages,
                    ...(evaluationResult
                      ? [evaluationResult.message]
                      : []),
                    {
                      role: "assistant",
                      content: assistantContent,
                      metrics: assistantTurnMetrics,
                      toolCalls: answerDecisionToolCall
                        ? [answerDecisionToolCall, ...assistantToolCalls]
                        : assistantToolCalls,
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
                return;
              }
            } else {
              progressDecision = {
                toolCall: "continue_current_milestone",
                reason: "No learner-facing question was answered.",
              };
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
              topic: userMessage.content,
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
            conversationMessages = [
              userMessage,
              buildCourseTocGeneratedMessage(course),
            ];
            messages = conversationMessages;
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
            onQuestionWidgetToolDelta() {
              if (sentQuestionWidgetPending) {
                return;
              }

              sentQuestionWidgetPending = true;
              send("question_widget_pending", {});
            },
          });
          assistantContent = assistantTurn.content;
          assistantToolCalls = assistantTurn.toolCalls;
          if (assistantToolCalls.length > 0) {
            send("question_widget", { toolCalls: assistantToolCalls });
          }
          latencyMetrics.chat_stream_ms = Date.now() - chatStreamStartedAt;

          if (finalCoursePromise) {
            course = await finalCoursePromise;
          }

          const evaluationResult =
            questionEvaluationResult as CourseQuestionEvaluationResult | null;
          const tocGenerationMessages = finalCoursePromise
            ? [buildCourseTocGeneratedMessage(course)]
            : [];
          const chatMessages = await appendCourseChatMessages({
            courseId: course.id,
            messages: [
              userMessage,
              ...tocGenerationMessages,
              ...(evaluationResult
                ? [evaluationResult.message]
                : []),
              {
                role: "assistant",
                content: assistantContent,
                metrics: assistantTurnMetrics,
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
