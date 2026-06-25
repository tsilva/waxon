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
  shouldUseCourseAnswerContinuationRequest,
  streamCourseAnswerContinuation,
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
  type CourseChatMessageEvaluation,
  type CourseDetail,
} from "@/app/lib/courseStore";
import type { CourseMessageMetrics } from "@/app/lib/courseMessageMetrics";
import {
  normalizeCourseQuestionWidgetToolCalls,
  type CourseQuestionWidgetAnswerDetails,
  type CourseQuestionWidgetToolCall,
} from "@/app/lib/courseQuestionWidget";
import type { CourseToc } from "@/app/lib/courseContent";
import {
  getOpenRouterLearnConfig,
} from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_CHAT_BODY_BYTES = 256 * 1024;
const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_MESSAGE_CHARS = 16_000;
const MAX_STORED_CHAT_MESSAGES = 200;
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
): CourseChatMessageEvaluation | null {
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
  const messages = storedMessages.slice(-MAX_CHAT_MESSAGES);
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
        let turnCost = 0;
        let intakeDecisionMetrics: CourseMessageMetrics | null = null;
        let answerDecisionMetrics: CourseMessageMetrics | null = null;
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
          answerDecision: Awaited<ReturnType<typeof generateCourseAnswerDecision>>,
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

            if (shouldUseCourseAnswerContinuationRequest(messages)) {
              send("evaluation_pending", {});
              const runSingleStreamContinuation = async (
                retryInstruction: string | null,
              ) => {
                assistantContent = "";
                assistantToolCalls = [];
                sentQuestionWidgetPending = false;
                questionEvaluationResult = null;
                answerDecisionMetrics = null;
                assistantTurnMetrics = null;
                const activeCourse = course;

                if (!activeCourse) {
                  throw new Error("Course could not be loaded.");
                }

                const chatStreamStartedAt = Date.now();
                let singleStreamAnswerDecision: Awaited<
                  ReturnType<typeof generateCourseAnswerDecision>
                > | null = null;
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
                await applyAnswerDecision(
                  singleStreamAnswerDecision ?? assistantTurn.answerDecision,
                  null,
                );
                latencyMetrics.chat_stream_ms =
                  Date.now() - chatStreamStartedAt;
              };
              let singleStreamSucceeded = false;

              try {
                await runSingleStreamContinuation(null);
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
                  await runSingleStreamContinuation(reason);
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
                const chatMessages = await replaceCourseChatMessages({
                  courseId: course.id,
                  messages: [
                    ...storedMessages,
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
                return;
              }

              send("status", { status: "Checking answer" });
              const answerDecisionStartedAt = Date.now();
              const answerDecision = await generateCourseAnswerDecision({
                apiKey: openRouterConfig.apiKey,
                model: openRouterConfig.model,
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
              const checkedProgressDecision = requireCourseMilestoneMastery({
                progressDecision: answerDecision.progressDecision,
                evaluationScore:
                  answerDecision.questionAttempt.toolCall ===
                  "record_course_question_attempt"
                    ? answerDecision.questionAttempt.score
                    : null,
              });
              await applyAnswerDecision(
                {
                  ...answerDecision,
                  progressDecision: checkedProgressDecision,
                },
                answerDecisionMetrics,
              );
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
          const chatMessages = await replaceCourseChatMessages({
            courseId: course.id,
            messages: [
              ...storedMessages,
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
