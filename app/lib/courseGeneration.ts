import {
  DEFAULT_OPENROUTER_LEARN_MODEL,
  extractChatCompletionToolCalls,
  extractChatCompletionText,
  getOpenRouterEvaluationReasoning,
  mergeStreamingToolCallDeltas,
  openRouterChatCompletion,
  type OpenRouterChatResponse,
  type OpenRouterMessage,
  type OpenRouterChatRequest,
  type OpenRouterToolCall,
} from "./openRouter.ts";
import { extractJsonObject } from "./jsonObject.ts";
import {
  parseCourseTocJson,
  type CourseToc,
} from "./courseContent.ts";
import {
  CourseTutorTextMissingError,
  ensureCourseChatTurnHasLearnerQuestion,
  excerptCourseMessageForPrompt,
} from "./courseChatTurn.ts";
import {
  metricsFromOpenRouterUsage,
  type CourseMessageMetrics,
} from "./courseMessageMetrics.ts";
import {
  parseCourseQuestionAttemptToolResult,
  parseCourseAnswerDecisionToolResult,
  type CourseQuestionAttemptToolResult,
  type CourseAnswerDecisionToolResult,
} from "./courseQuestionAttemptParsing.ts";
import {
  COURSE_ANSWER_DECISION_TOOL_NAME,
  COURSE_QUESTION_WIDGET_TOOL_NAME,
  COURSE_TOC_TOOL_NAME,
  courseQuestionWidgetToolCallFromWidget,
  courseQuestionWidgetsFromToolCalls,
  formatCourseQuestionWidgetsForPrompt,
  normalizeCourseToolCalls,
  type CourseAnswerDecisionToolCall,
  type CourseQuestionWidget,
  type CourseQuestionWidgetAnswerDetails,
  type CourseToolCall,
  type CourseQuestionWidgetToolCall,
} from "./courseQuestionWidget.ts";
import {
  normalizePartialCourseToc,
  type PartialCourseToc,
} from "./courseTocStream.ts";
import type {
  CourseChatMessageRecord,
  CourseChatMessageEvaluation,
  CourseDetail,
} from "./courseStore";
import type { CourseProgressDecision } from "./courseProgress.ts";
import {
  loadPromptTemplate,
  renderPromptTemplate,
} from "./promptTemplates.ts";

const COURSE_JSON_RESPONSE_FORMAT = { type: "json_object" };
const COURSE_QUESTION_WIDGET_TOOL = {
  type: "function",
  function: {
    name: COURSE_QUESTION_WIDGET_TOOL_NAME,
    description:
      "Render one learner-facing question widget after the tutor explanation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["free_text", "multiple_choice"],
        },
        id: {
          type: "string",
          description: "Short stable identifier for this question.",
        },
        question: {
          type: "string",
          description: "Self-contained learner-facing question.",
        },
        placeholder: {
          type: "string",
          description: "Placeholder text for free-text widgets.",
        },
        choices: {
          type: "array",
          description:
            "Answer choices for multiple-choice widgets. Use A, B, C, D ids.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description: "Choice id such as A, B, C, or D.",
              },
              text: {
                type: "string",
                description: "Choice text.",
              },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["type", "id", "question"],
    },
  },
} as const;
const COURSE_TOC_TOOL = {
  type: "function",
  function: {
    name: COURSE_TOC_TOOL_NAME,
    description:
      "Generate the learner-facing table of contents for a new Learn course.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: {
          type: "string",
          description: "The learner's requested course topic.",
        },
        toc: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              description: "Specific course title.",
            },
            description: {
              type: "string",
              description: "Short course description.",
            },
            pages: {
              type: "array",
              description:
                "Flat course pages. Do not group pages into chapters or sections.",
              minItems: 6,
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: {
                    type: "string",
                    description: "Specific page title.",
                  },
                  objective: {
                    type: "string",
                    description:
                      "Learner-facing objective for this page.",
                  },
                },
                required: ["title", "objective"],
              },
            },
          },
          required: ["title", "description", "pages"],
        },
      },
      required: ["topic", "toc"],
    },
  },
} as const;
const COURSE_ANSWER_DECISION_TOOL = {
  type: "function",
  function: {
    name: COURSE_ANSWER_DECISION_TOOL_NAME,
    description:
      "Record the learner's latest answer evaluation and decide whether the current course milestone is complete.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        questionAttempt: {
          type: "object",
          additionalProperties: false,
          properties: {
            toolCall: {
              type: "string",
              enum: [
                "record_course_question_attempt",
                "skip_course_question_attempt",
              ],
            },
            question: {
              type: "string",
              description: "Self-contained recall prompt being answered.",
            },
            answer: {
              type: "string",
              description: "Learner's submitted answer.",
            },
            answerSummary: {
              type: "string",
              description: "Short summary of the learner answer.",
            },
            conciseAnswer: {
              type: "string",
              description: "Concise model-normalized answer.",
            },
            correctAnswer: {
              type: "string",
              description: "Concise ideal answer.",
            },
            justification: {
              type: "string",
              description: "Brief grading reason.",
            },
            score: {
              type: "number",
              minimum: 0,
              maximum: 10,
            },
            reason: {
              type: "string",
              description: "Reason when skipping.",
            },
          },
          required: [
            "toolCall",
            "question",
            "answer",
            "answerSummary",
            "conciseAnswer",
            "correctAnswer",
            "justification",
            "score",
          ],
        },
        progressDecision: {
          type: "object",
          additionalProperties: false,
          properties: {
            toolCall: {
              type: "string",
              enum: ["mark_milestone_done", "continue_current_milestone"],
            },
            reason: {
              type: "string",
            },
          },
          required: ["toolCall", "reason"],
        },
      },
      required: ["questionAttempt", "progressDecision"],
    },
  },
} as const;
const MAX_INTAKE_MESSAGE_CHARS = 500;
const MAX_INTAKE_TOPIC_CHARS = 800;
const COURSE_CHAT_TURN_MAX_TOKENS = 1_200;
const COURSE_CHAT_CACHEABLE_TEACHING_RUBRIC = loadPromptTemplate(
  "course-chat-cacheable-teaching-rubric.md",
);
const COURSE_CHAT_VISIBLE_TEXT_RETRY_INSTRUCTION =
  "Retry the same Learn turn. Your previous response called render_question_widget but omitted the visible learner-facing lesson. First write concise beginner tutor prose that explains the idea, then call render_question_widget exactly once. Do not put the question or answer choices in visible prose.";
const COURSE_ANSWER_CONTINUATION_VISIBLE_TEXT_MISSING_ERROR_MESSAGE =
  "Course answer continuation did not emit visible tutor text after the answer decision.";
export const COURSE_ANSWER_CONTINUATION_VISIBLE_TEXT_RETRY_INSTRUCTION =
  "Retry the same Learn answer-continuation turn. Your previous response recorded the answer decision but omitted visible learner-facing tutor text. Your assistant message content must not be empty; a tools-only response is invalid. Write concise tutor prose that responds to the learner's answer and teaches the next smallest idea, then call render_question_widget exactly once unless the course is complete. Still call record_course_answer_decision exactly once. Do not put the question or answer choices in visible prose.";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const MODEL_CONTEXT_WINDOW_TOKENS: Array<{
  pattern: RegExp;
  tokens: number;
}> = [
  { pattern: /gemini-(?:1\.5|2(?:\.[05])?|3(?:\.[015])?)-flash(?:-lite)?/iu, tokens: 1_000_000 },
  { pattern: /gemini-(?:1\.5|2(?:\.[05])?|3(?:\.[015])?)-pro/iu, tokens: 1_000_000 },
  { pattern: /gpt-4\.1|gpt-5/iu, tokens: 1_000_000 },
  { pattern: /claude-(?:3\.5|3\.7|4|4\.5)/iu, tokens: 200_000 },
];

type CourseCostObserver = {
  onCost?: (cost: number) => void;
  onMetrics?: (metrics: CourseMessageMetrics) => void;
};

type OpenRouterTextContentBlock = {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
  };
};

export type CourseIntakeMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CourseIntakeDecision =
  | {
      action: "clarify";
      message: string;
    }
  | {
      action: "create_course";
      topic: string;
      message: string;
    };

export type CourseChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: CourseToolCall[];
  metrics?: CourseMessageMetrics | null;
  evaluation?: CourseChatMessageEvaluation | null;
  widgetAnswer?: CourseQuestionWidgetAnswerDetails | null;
};

export type { CourseQuestionAttemptToolResult };
export type { CourseAnswerDecisionToolResult };

export function storedCourseChatMessageToPromptMessage(
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

function normalizeIntakeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function reportResponseMetrics(
  input: CourseCostObserver,
  usage:
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        cost?: unknown;
      }
    | undefined,
  latencyMs: number,
  model: string | undefined,
) {
  const cost =
    typeof usage?.cost === "number"
      ? usage.cost
      : typeof usage?.cost === "string"
        ? Number.parseFloat(usage.cost)
        : null;

  if (cost !== null && Number.isFinite(cost) && cost > 0) {
    input.onCost?.(cost);
  }

  const metrics = metricsFromOpenRouterUsage(
    usage,
    latencyMs,
    resolveContextWindowTokens(model),
  );

  if (metrics) {
    input.onMetrics?.(metrics);
  }
}

function extractChatCompletionWidgetToolCalls(
  body: OpenRouterChatResponse,
): CourseQuestionWidgetToolCall[] {
  const rawToolCalls = body.choices?.[0]?.message?.tool_calls;

  if (!rawToolCalls?.length) {
    return [];
  }

  return rawToolCalls.flatMap((toolCall) => {
    if (toolCall.function?.name !== COURSE_QUESTION_WIDGET_TOOL_NAME) {
      return [];
    }

    return courseQuestionWidgetsFromToolCalls([toolCall]).map((widget) =>
      courseQuestionWidgetToolCallFromWidget(widget, toolCall.id),
    );
  });
}

function parseToolCallArguments(toolCall: OpenRouterToolCall): unknown | null {
  const rawArguments = toolCall.function?.arguments;

  if (!rawArguments) {
    return null;
  }

  try {
    return JSON.parse(rawArguments);
  } catch {
    return null;
  }
}

function validateRawAnswerDecisionToolValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Answer decision tool arguments must be an object.";
  }

  const record = value as Record<string, unknown>;
  const questionAttempt = record.questionAttempt;
  const progressDecision = record.progressDecision;

  if (
    !questionAttempt ||
    typeof questionAttempt !== "object" ||
    Array.isArray(questionAttempt)
  ) {
    return "Answer decision tool requires questionAttempt.";
  }

  if (
    !progressDecision ||
    typeof progressDecision !== "object" ||
    Array.isArray(progressDecision)
  ) {
    return "Answer decision tool requires progressDecision.";
  }

  const attemptRecord = questionAttempt as Record<string, unknown>;
  const progressRecord = progressDecision as Record<string, unknown>;
  const attemptToolCall = normalizeIntakeText(attemptRecord.toolCall, 80);
  const progressToolCall = normalizeIntakeText(progressRecord.toolCall, 80);

  if (
    attemptToolCall !== "record_course_question_attempt" &&
    attemptToolCall !== "skip_course_question_attempt"
  ) {
    return "questionAttempt.toolCall is invalid.";
  }

  if (
    progressToolCall !== "mark_milestone_done" &&
    progressToolCall !== "continue_current_milestone"
  ) {
    return "progressDecision.toolCall is invalid.";
  }

  if (attemptToolCall === "record_course_question_attempt") {
    const requiredStringFields = [
      "question",
      "answer",
      "answerSummary",
      "conciseAnswer",
      "correctAnswer",
      "justification",
    ];
    const missingField = requiredStringFields.find(
      (field) => !normalizeIntakeText(attemptRecord[field], 1_200),
    );

    if (missingField) {
      return `questionAttempt.${missingField} is required.`;
    }

    if (
      typeof attemptRecord.score !== "number" ||
      !Number.isFinite(attemptRecord.score) ||
      attemptRecord.score < 0 ||
      attemptRecord.score > 10
    ) {
      return "questionAttempt.score must be a number from 0 to 10.";
    }
  } else if (!normalizeIntakeText(attemptRecord.reason, 500)) {
    return "Skipped questionAttempt requires a reason.";
  }

  if (!normalizeIntakeText(progressRecord.reason, 500)) {
    return "progressDecision.reason is required.";
  }

  return null;
}

function parseStrictCourseAnswerDecisionToolCall(input: {
  toolCall: OpenRouterToolCall;
  fallbackAnswer: string;
  choiceSource: string;
  requireRecordedAttempt: boolean;
}): CourseAnswerDecisionToolResult | null {
  if (input.toolCall.function?.name !== COURSE_ANSWER_DECISION_TOOL_NAME) {
    return null;
  }

  const value = parseToolCallArguments(input.toolCall);

  if (!value) {
    return null;
  }

  const validationError = validateRawAnswerDecisionToolValue(value);

  if (validationError) {
    throw new Error(validationError);
  }

  const decision = parseCourseAnswerDecisionToolResult(
    JSON.stringify(value),
    input.fallbackAnswer,
    input.choiceSource,
  );

  if (
    input.requireRecordedAttempt &&
    decision.questionAttempt.toolCall !== "record_course_question_attempt"
  ) {
    throw new Error("Answer decision did not record the answered question.");
  }

  return decision;
}

function didReachMaxCompletionTokens(
  usage:
    | {
        completion_tokens?: unknown;
      }
    | undefined,
  maxTokens: number,
): boolean {
  const completionTokens =
    typeof usage?.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage?.completion_tokens === "string"
        ? Number.parseFloat(usage.completion_tokens)
        : null;

  return (
    completionTokens !== null &&
    Number.isFinite(completionTokens) &&
    completionTokens >= maxTokens - 8
  );
}

function resolveContextWindowTokens(model: string | undefined): number | null {
  const configuredLimit = process.env.LLM_CONTEXT_WINDOW_TOKENS?.trim();

  if (configuredLimit) {
    const parsedLimit = Number.parseInt(configuredLimit, 10);

    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      return parsedLimit;
    }
  }

  const modelName = (model ?? DEFAULT_OPENROUTER_LEARN_MODEL).trim();
  const matchedContextWindow = MODEL_CONTEXT_WINDOW_TOKENS.find(({ pattern }) =>
    pattern.test(modelName),
  );

  return matchedContextWindow?.tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function parseCourseIntakeDecision(source: string): CourseIntakeDecision {
  const value = extractJsonObject(source);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Course intake response must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const action = normalizeIntakeText(record.action, 40);
  const message = normalizeIntakeText(record.message, MAX_INTAKE_MESSAGE_CHARS);

  if (action === "clarify") {
    if (!message) {
      throw new Error("Course intake clarification requires a message.");
    }

    return {
      action,
      message,
    };
  }

  if (action === "create_course") {
    const topic = normalizeIntakeText(record.topic, MAX_INTAKE_TOPIC_CHARS);

    if (!topic) {
      throw new Error("Course intake creation requires a topic.");
    }

    return {
      action,
      topic,
      message: message || "I have enough context. I am generating the course.",
    };
  }

  throw new Error("Course intake action must be clarify or create_course.");
}

function parseCourseProgressDecision(source: string): CourseProgressDecision {
  const value = extractJsonObject(source);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Course progress response must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const toolCall = normalizeIntakeText(record.toolCall, 80);
  const reason = normalizeIntakeText(record.reason, 500);

  if (toolCall === "mark_milestone_done") {
    return {
      toolCall,
      reason: reason || "The learner demonstrated enough understanding.",
    };
  }

  return {
    toolCall: "continue_current_milestone",
    reason: reason || "The learner needs another short check.",
  };
}

function currentCourseMilestone(course: CourseDetail) {
  const page = course.toc.pages[course.currentPageIndex];

  if (!page) {
    throw new Error("Course current position does not exist.");
  }

  return { page };
}

function compactCourseMessages(messages: CourseChatMessage[]) {
  return messages.slice(-10).map((message) => ({
    role: message.role,
    content: excerptCourseMessageForPrompt(
      courseMessagePromptContext(message),
      1_200,
    ),
  }));
}

function courseChatMessagesForModel(
  messages: CourseChatMessage[],
): OpenRouterMessage[] {
  const selectedMessages = selectCourseMessagesForModel(messages);
  const modelMessages: OpenRouterMessage[] = [];

  for (let index = 0; index < selectedMessages.length; index += 1) {
    const message = selectedMessages[index];

    if (!message) {
      continue;
    }

    if (message.role === "assistant" && message.evaluation) {
      continue;
    }

    if (message.role === "user") {
      if (!message.widgetAnswer?.answer) {
        modelMessages.push({
          role: "user",
          content: message.content,
        });
      }

      continue;
    }

    const toolCalls = normalizeCourseToolCalls(message.toolCalls);

    if (toolCalls.length === 0) {
      modelMessages.push({
        role: "assistant",
        content: message.content,
      });
      continue;
    }

    const nextMessage = selectedMessages[index + 1];
    const nextWidgetAnswer =
      nextMessage?.role === "user" ? nextMessage.widgetAnswer : null;
    const shouldConsumeNextWidgetAnswer = Boolean(
      nextWidgetAnswer?.answer &&
        toolCalls.some((toolCall) =>
          isMatchingWidgetAnswerToolCall(toolCall, nextWidgetAnswer),
        ),
    );
    const toolCallsWithResults = toolCalls.filter(
      (toolCall) =>
        toolCall.function.name !== COURSE_QUESTION_WIDGET_TOOL_NAME ||
        isMatchingWidgetAnswerToolCall(toolCall, nextWidgetAnswer),
    );
    const hasUnansweredWidgetToolCalls =
      toolCallsWithResults.length < toolCalls.length;

    if (toolCallsWithResults.length === 0) {
      modelMessages.push({
        role: "assistant",
        content: hasUnansweredWidgetToolCalls
          ? courseMessagePromptContext(message)
          : message.content,
      });
      continue;
    }

    modelMessages.push({
      role: "assistant",
      content: shouldSuppressAssistantToolContent(message)
        ? ""
        : hasUnansweredWidgetToolCalls
          ? courseMessagePromptContext(message)
          : message.content,
      tool_calls: toolCallsWithResults.map(openRouterToolCallFromCourseToolCall),
    });

    for (const toolCall of toolCallsWithResults) {
      modelMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: courseToolResponseContent(
          toolCall,
          shouldConsumeNextWidgetAnswer ? (nextWidgetAnswer ?? null) : null,
        ),
      });
    }

    if (shouldConsumeNextWidgetAnswer) {
      index += 1;
    }
  }

  return modelMessages;
}

function selectCourseMessagesForModel(
  messages: CourseChatMessage[],
): CourseChatMessage[] {
  return messages;
}

function openRouterToolCallFromCourseToolCall(
  toolCall: CourseToolCall,
): OpenRouterToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: JSON.stringify(toolCall.function.arguments),
    },
  };
}

function shouldSuppressAssistantToolContent(message: CourseChatMessage): boolean {
  return (
    message.content.trim() === "Generated the course table of contents." &&
    normalizeCourseToolCalls(message.toolCalls).some(
      (toolCall) => toolCall.function.name === COURSE_TOC_TOOL_NAME,
    )
  );
}

function isMatchingWidgetAnswerToolCall(
  toolCall: CourseToolCall,
  widgetAnswer: CourseQuestionWidgetAnswerDetails | null | undefined,
): boolean {
  if (
    !widgetAnswer?.answer ||
    toolCall.function.name !== COURSE_QUESTION_WIDGET_TOOL_NAME
  ) {
    return false;
  }

  return widgetAnswer.widgetId
    ? toolCall.function.arguments.id === widgetAnswer.widgetId
    : true;
}

function courseToolResponseContent(
  toolCall: CourseToolCall,
  widgetAnswer: CourseQuestionWidgetAnswerDetails | null,
): string {
  if (toolCall.function.name === COURSE_TOC_TOOL_NAME) {
    return JSON.stringify({
      topic: toolCall.function.arguments.topic,
      toc: toolCall.function.arguments.toc,
    });
  }

  if (toolCall.function.name === COURSE_QUESTION_WIDGET_TOOL_NAME) {
    if (!widgetAnswer?.answer) {
      throw new Error("Question widget tool responses require a learner answer.");
    }

    return widgetAnswer.answer;
  }

  if (toolCall.function.name === COURSE_ANSWER_DECISION_TOOL_NAME) {
    const { progressDecision, questionAttempt } = toolCall.function.arguments;
    const stateText =
      progressDecision.toolCall === "mark_milestone_done"
        ? "advanced to the next lesson"
        : "continued the current lesson";
    const scoreText =
      questionAttempt.toolCall === "record_course_question_attempt"
        ? ` Score: ${Math.round(questionAttempt.score)}/10.`
        : "";

    return `Course state update: ${stateText}. Reason: ${progressDecision.reason}.${scoreText}`;
  }

  throw new Error("Unsupported course tool call.");
}

function courseMessagePromptContext(message: CourseChatMessage): string {
  const toolWidgets = courseQuestionWidgetsFromToolCalls(message.toolCalls);

  if (toolWidgets.length === 0) {
    return message.content;
  }

  return [
    message.content,
    formatCourseQuestionWidgetsForPrompt(toolWidgets),
  ].join("\n\n");
}

function supportsExplicitOpenRouterPromptCaching(model: string): boolean {
  return /^(?:google\/gemini|anthropic\/|qwen\/)/iu.test(model);
}

function cacheableTextBlock(text: string): OpenRouterTextContentBlock {
  return {
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  };
}

function textBlock(text: string): OpenRouterTextContentBlock {
  return {
    type: "text",
    text,
  };
}

function openRouterPromptContent(input: {
  text: string;
  model: string;
  cacheable?: boolean;
}): string | OpenRouterTextContentBlock[] {
  if (!supportsExplicitOpenRouterPromptCaching(input.model)) {
    return input.text;
  }

  return input.cacheable
    ? [cacheableTextBlock(input.text)]
    : [textBlock(input.text)];
}

function courseChatSessionId(input: {
  userId: string;
  course: CourseDetail;
}): string {
  void input.course;
  return `learn:${input.userId}:course-chat-v10`.slice(0, 256);
}

function courseAnswerDecisionSessionId(input: { userId: string }): string {
  return `learn:${input.userId}:course-answer-decision-v2`.slice(0, 256);
}

function courseAnswerDecisionSupportsCacheControl(model: string): boolean {
  return (
    supportsExplicitOpenRouterPromptCaching(model) ||
    model.trim().toLowerCase() === "inception/mercury-2"
  );
}

function courseAnswerDecisionPromptContent(input: {
  model: string;
  text: string;
  cacheable?: boolean;
}): string | OpenRouterTextContentBlock[] {
  if (!courseAnswerDecisionSupportsCacheControl(input.model)) {
    return input.text;
  }

  return input.cacheable
    ? [cacheableTextBlock(input.text)]
    : [textBlock(input.text)];
}

export function buildFallbackCourseToc(topic: string): CourseToc {
  const title = normalizeIntakeText(topic, 80) || "Focused Mini-Course";

  return {
    title,
    description: `A focused chat course about ${title}.`,
    pages: [
      {
        title: "Main Idea",
        objective: `State the central idea behind ${title}.`,
      },
      {
        title: "Working Parts",
        objective: `Explain the most important moving parts in ${title}.`,
      },
      {
        title: "Apply It",
        objective: `Use ${title} in a small concrete example.`,
      },
      {
        title: "Check Understanding",
        objective: `Recognize a common mistake or limitation in ${title}.`,
      },
    ],
  };
}

export async function generateCourseIntakeDecision(input: {
  apiKey: string;
  model?: string;
  userId: string;
  messages: CourseIntakeMessage[];
} & CourseCostObserver): Promise<CourseIntakeDecision> {
  const compactMessages = input.messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.content.slice(0, MAX_INTAKE_TOPIC_CHARS),
  }));
  const startedAt = Date.now();

  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_intake",
      userId: input.userId,
      question: compactMessages.at(-1)?.content ?? null,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.25,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: loadPromptTemplate("course-intake-system.md"),
        },
        ...compactMessages,
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course intake failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  return parseCourseIntakeDecision(extractChatCompletionText(body));
}

export async function evaluateCourseChatProgress(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
} & CourseCostObserver): Promise<CourseProgressDecision> {
  const { page } = currentCourseMilestone(input.course);
  const startedAt = Date.now();
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_chat_progress",
      userId: input.userId,
      question: page.title,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.15,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: loadPromptTemplate("course-progress-system.md"),
        },
        {
          role: "user",
          content: renderPromptTemplate(loadPromptTemplate("course-progress-user.md"), {
            courseTitle: input.course.title,
            currentMilestone: page.title,
            milestoneObjective: page.objective,
            conversationJson: JSON.stringify(compactCourseMessages(input.messages)),
          }),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course progress evaluation failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  return parseCourseProgressDecision(extractChatCompletionText(body));
}

function latestAnsweredWidgetContext(messages: CourseChatMessage[]): {
  question: string | null;
  answer: string;
  choiceSource: string;
  widget: CourseQuestionWidget | null;
} | null {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const previousAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const parsedAnswer = latestUserMessage?.widgetAnswer ?? null;

  if (!latestUserMessage || !previousAssistantMessage || !parsedAnswer) {
    return null;
  }

  const toolWidgets = courseQuestionWidgetsFromToolCalls(
    previousAssistantMessage.toolCalls,
  );
  const matchedWidget =
    toolWidgets.find(
      (widget) => widget.id === parsedAnswer.widgetId,
    ) ??
    toolWidgets.at(-1);
  const question = parsedAnswer.question ?? matchedWidget?.question ?? null;

  return {
    question,
    answer: parsedAnswer.answer,
    choiceSource: courseMessagePromptContext(previousAssistantMessage),
    widget: matchedWidget ?? null,
  };
}

function buildCourseAnswerDecisionUserPrompt(input: {
  course: CourseDetail;
  page: CourseToc["pages"][number];
  previousAssistantContent: string;
  latestUserContent: string;
  answeredWidget: ReturnType<typeof latestAnsweredWidgetContext>;
}): string {
  if (input.answeredWidget) {
    return renderPromptTemplate(loadPromptTemplate("course-answer-decision-user.md"), {
      courseTitle: input.course.title,
      currentMilestone: input.page.title,
      milestoneObjective: input.page.objective,
      answeredWidgetBlock: input.answeredWidget.widget
        ? `Answered widget JSON: ${JSON.stringify(input.answeredWidget.widget)}`
        : `Answered widget question: ${input.answeredWidget.question ?? "unknown"}`,
      lessonContextBlock: `Short lesson context:\n${excerptCourseMessageForPrompt(input.previousAssistantContent, 900)}`,
      latestLearnerAnswerBlock: `Learner answer: ${input.answeredWidget.answer}`,
    });
  }

  return renderPromptTemplate(loadPromptTemplate("course-answer-decision-user.md"), {
    courseTitle: input.course.title,
    currentMilestone: input.page.title,
    milestoneObjective: input.page.objective,
    answeredWidgetBlock: `Previous assistant message:\n${excerptCourseMessageForPrompt(input.previousAssistantContent, 2_000)}`,
    lessonContextBlock: "",
    latestLearnerAnswerBlock: `Latest learner answer:\n${excerptCourseMessageForPrompt(input.latestUserContent, 2_000)}`,
  }).replace(/\n{3,}/gu, "\n\n");
}

export async function generateCourseAnswerDecision(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
} & CourseCostObserver): Promise<CourseAnswerDecisionToolResult> {
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  const previousAssistantMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!latestUserMessage || !previousAssistantMessage) {
    return {
      questionAttempt: {
        toolCall: "skip_course_question_attempt",
        reason: "No prior tutor question and learner answer pair exists.",
      },
      progressDecision: {
        toolCall: "continue_current_milestone",
        reason: "No prior tutor question and learner answer pair exists.",
      },
    };
  }

  if (
    normalizeIntakeText(previousAssistantMessage.content, 80).toLowerCase() ===
    "what do you want to learn?"
  ) {
    return {
      questionAttempt: {
        toolCall: "skip_course_question_attempt",
        reason: "The initial course intake prompt is not a review question.",
      },
      progressDecision: {
        toolCall: "continue_current_milestone",
        reason: "The initial course intake prompt is not a review question.",
      },
    };
  }

  const { page } = currentCourseMilestone(input.course);
  const answeredWidget = latestAnsweredWidgetContext(input.messages);
  const model = input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL;
  const systemPrompt = loadPromptTemplate("course-answer-decision-system.md");
  const startedAt = Date.now();
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_answer_decision",
      userId: input.userId,
      question: page.title,
    },
    body: {
      model,
      session_id: courseAnswerDecisionSessionId({ userId: input.userId }),
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      reasoning: getOpenRouterEvaluationReasoning(model),
      temperature: 0,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: courseAnswerDecisionPromptContent({
            model,
            text: systemPrompt,
            cacheable: true,
          }),
        },
        {
          role: "user",
          content: courseAnswerDecisionPromptContent({
            model,
            text: buildCourseAnswerDecisionUserPrompt({
              course: input.course,
              page,
              previousAssistantContent: previousAssistantMessage.content,
              latestUserContent: latestUserMessage.content,
              answeredWidget,
            }),
          }),
        },
      ],
    },
  });

  if (!response.ok) {
    return {
      questionAttempt: {
        toolCall: "skip_course_question_attempt",
        reason: "Course answer decision failed.",
      },
      progressDecision: {
        toolCall: "continue_current_milestone",
        reason: "Course answer decision failed.",
      },
    };
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  return parseCourseAnswerDecisionToolResult(
    extractChatCompletionText(body),
    answeredWidget?.answer ?? latestUserMessage.content,
    answeredWidget?.choiceSource ?? previousAssistantMessage.content,
  );
}

export async function generateCourseQuestionAttemptToolResult(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
} & CourseCostObserver): Promise<CourseQuestionAttemptToolResult> {
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  const previousAssistantMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!latestUserMessage || !previousAssistantMessage) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "No prior tutor question and learner answer pair exists.",
    };
  }

  if (
    normalizeIntakeText(previousAssistantMessage.content, 80).toLowerCase() ===
    "what do you want to learn?"
  ) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "The initial course intake prompt is not a review question.",
    };
  }

  const { page } = currentCourseMilestone(input.course);
  const startedAt = Date.now();
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_question_attempt_tool",
      userId: input.userId,
      question: page.title,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: loadPromptTemplate("course-question-attempt-system.md"),
        },
        {
          role: "user",
          content: renderPromptTemplate(
            loadPromptTemplate("course-question-attempt-user.md"),
            {
              courseTitle: input.course.title,
              currentMilestone: page.title,
              milestoneObjective: page.objective,
              previousAssistantMessage: excerptCourseMessageForPrompt(
                courseMessagePromptContext(previousAssistantMessage),
                4_000,
              ),
              latestWidgetAnswerMetadataBlock: latestUserMessage.widgetAnswer
                ? `Latest widget answer metadata:\n${JSON.stringify(latestUserMessage.widgetAnswer)}`
                : "",
              latestLearnerAnswer: excerptCourseMessageForPrompt(
                latestUserMessage.content,
                4_000,
              ),
            },
          ).replace(/\n{3,}/gu, "\n\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "Question attempt tool failed.",
    };
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  return parseCourseQuestionAttemptToolResult(
    extractChatCompletionText(body),
    latestUserMessage.content,
    courseMessagePromptContext(previousAssistantMessage),
  );
}

function buildCourseTutorSystemPrompt(input: {
  answerDecisionTool: boolean;
}): string {
  const answerDecisionToolInstructions = input.answerDecisionTool
    ? renderPromptTemplate(
        loadPromptTemplate("course-tutor-answer-decision-tool-instructions.md"),
        {
          answerDecisionToolName: COURSE_ANSWER_DECISION_TOOL_NAME,
          questionWidgetToolName: COURSE_QUESTION_WIDGET_TOOL_NAME,
        },
      )
    : "";

  return renderPromptTemplate(loadPromptTemplate("course-tutor-system.md"), {
    answerDecisionToolInstructions,
    questionWidgetToolName: COURSE_QUESTION_WIDGET_TOOL_NAME,
  }).replace(/\n{3,}/gu, "\n\n");
}

export type CourseChatModelRequestPreview =
  | {
      kind: "course_chat_turn";
      model: string;
      pageTitle: string;
      requestBody: OpenRouterChatRequest;
    }
  | {
      kind: "course_answer_continuation";
      model: string;
      pageTitle: string;
      nextPageTitle: string | null;
      requestBody: OpenRouterChatRequest;
    };

export function shouldUseCourseAnswerContinuationRequest(
  messages: CourseChatMessage[],
  model?: string,
): boolean {
  const normalizedModel = (model ?? DEFAULT_OPENROUTER_LEARN_MODEL)
    .trim()
    .toLowerCase();

  if (normalizedModel === "google/gemini-3.1-flash-lite") {
    return false;
  }

  const previousAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.evaluation);
  const previousAssistantText = (previousAssistantMessage?.content ?? "")
    .trim()
    .toLowerCase();

  return Boolean(
    previousAssistantText &&
      previousAssistantText !== "what do you want to learn?",
  );
}

export function courseAnswerContinuationRetryInstructionForError(
  error: unknown,
): string | null {
  const message = error instanceof Error ? error.message : "";

  return message === COURSE_ANSWER_CONTINUATION_VISIBLE_TEXT_MISSING_ERROR_MESSAGE
    ? COURSE_ANSWER_CONTINUATION_VISIBLE_TEXT_RETRY_INSTRUCTION
    : null;
}

export function buildCourseAnswerContinuationModelRequest(input: {
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  retryInstruction?: string | null;
  model?: string;
}): CourseChatModelRequestPreview & {
  latestUserMessage: CourseChatMessage;
  previousAssistantMessage: CourseChatMessage;
  answeredWidget: ReturnType<typeof latestAnsweredWidgetContext>;
  page: CourseToc["pages"][number];
  nextPage: CourseToc["pages"][number] | undefined;
} {
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  const previousAssistantMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!latestUserMessage || !previousAssistantMessage) {
    throw new Error("Answer continuation requires a prior question and answer.");
  }

  const { page } = currentCourseMilestone(input.course);
  const nextPage = input.course.toc.pages[input.course.currentPageIndex + 1];
  const answeredWidget = latestAnsweredWidgetContext(input.messages);
  const model = input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL;
  const systemPrompt = buildCourseTutorSystemPrompt({
    answerDecisionTool: true,
  });
  const stableTutorContext = [
    "Stable tutor instructions:",
    systemPrompt,
    "",
    COURSE_CHAT_CACHEABLE_TEACHING_RUBRIC,
  ].join("\n");
  const retryInstruction = input.retryInstruction?.trim();

  return {
    kind: "course_answer_continuation",
    model,
    pageTitle: page.title,
    nextPageTitle: nextPage?.title ?? null,
    page,
    nextPage,
    latestUserMessage,
    previousAssistantMessage,
    answeredWidget,
    requestBody: {
      model,
      session_id: courseChatSessionId({
        userId: input.userId,
        course: input.course,
      }),
      reasoning_effort: "minimal",
      temperature: 0.4,
      max_tokens: COURSE_CHAT_TURN_MAX_TOKENS,
      tools: [COURSE_ANSWER_DECISION_TOOL, COURSE_QUESTION_WIDGET_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: true,
      messages: [
        {
          role: "system",
          content: openRouterPromptContent({
            text: stableTutorContext,
            model,
            cacheable: true,
          }),
        },
        ...(retryInstruction
          ? [
              {
                role: "system" as const,
                content: retryInstruction,
              },
            ]
          : []),
        ...courseChatMessagesForModel(input.messages),
      ],
    },
  };
}

export function buildCourseChatTurnModelRequest(input: {
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  progressDecision?: CourseProgressDecision | null;
  retryInstruction?: string | null;
  model?: string;
}): CourseChatModelRequestPreview & {
  page: CourseToc["pages"][number];
} {
  const { page } = currentCourseMilestone(input.course);
  const model = input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL;
  const systemPrompt = buildCourseTutorSystemPrompt({
    answerDecisionTool: false,
  });
  const stableTutorContext = [
    "Stable tutor instructions:",
    systemPrompt,
    "",
    COURSE_CHAT_CACHEABLE_TEACHING_RUBRIC,
  ].join("\n");
  const retryInstruction = input.retryInstruction?.trim();
  void input.progressDecision;

  return {
    kind: "course_chat_turn",
    model,
    pageTitle: page.title,
    page,
    requestBody: {
      model,
      session_id: courseChatSessionId({
        userId: input.userId,
        course: input.course,
      }),
      reasoning_effort: "minimal",
      temperature: 0.5,
      max_tokens: COURSE_CHAT_TURN_MAX_TOKENS,
      tools: [COURSE_QUESTION_WIDGET_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
      messages: [
        {
          role: "system",
          content: openRouterPromptContent({
            text: stableTutorContext,
            model,
            cacheable: true,
          }),
        },
        ...(retryInstruction
          ? [
              {
                role: "system" as const,
                content: retryInstruction,
              },
            ]
          : []),
        ...courseChatMessagesForModel(input.messages),
      ],
    },
  };
}

export async function streamCourseAnswerContinuation(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  retryInstruction?: string | null;
  onTextDelta: (delta: string) => void;
  onQuestionWidgetToolDelta?: () => void;
  onAnswerDecision?: (
    decision: CourseAnswerDecisionToolResult,
  ) => void | Promise<void>;
} & CourseCostObserver): Promise<{
  content: string;
  toolCalls: CourseQuestionWidgetToolCall[];
  answerDecisionToolCall: CourseAnswerDecisionToolCall;
  answerDecision: CourseAnswerDecisionToolResult;
}> {
  const startedAt = Date.now();
  const request = buildCourseAnswerContinuationModelRequest({
    userId: input.userId,
    course: input.course,
    messages: input.messages,
    retryInstruction: input.retryInstruction,
    model: input.model,
  });
  const {
    answeredWidget,
    latestUserMessage,
    nextPage,
    page,
    previousAssistantMessage,
  } = request;
  const model = request.model;
  const streamedToolCalls: Array<OpenRouterToolCall & { index?: number }> = [];
  let reportedQuestionWidgetToolDelta = false;
  const acceptedAnswerDecisionRef: {
    current: CourseAnswerDecisionToolResult | null;
  } = {
    current: null,
  };
  const acceptedAnswerDecisionToolCallRef: {
    current: CourseAnswerDecisionToolCall | null;
  } = {
    current: null,
  };
  const requireRecordedAttempt = true;
  const choiceSource =
    answeredWidget?.choiceSource ??
    courseMessagePromptContext(previousAssistantMessage);
  const fallbackAnswer = answeredWidget?.answer ?? latestUserMessage.content;
  const tryAcceptAnswerDecision = async (
    toolCall: OpenRouterToolCall & { index?: number },
  ) => {
    if (
      acceptedAnswerDecisionRef.current ||
      toolCall.function?.name !== COURSE_ANSWER_DECISION_TOOL_NAME
    ) {
      return;
    }

    const decision = parseStrictCourseAnswerDecisionToolCall({
      toolCall,
      fallbackAnswer,
      choiceSource,
      requireRecordedAttempt,
    });

    if (!decision) {
      return;
    }

    const normalizedToolCall = normalizeCourseToolCalls([toolCall]).find(
      (candidate): candidate is CourseAnswerDecisionToolCall =>
        candidate.function.name === COURSE_ANSWER_DECISION_TOOL_NAME,
    );

    if (!normalizedToolCall) {
      throw new Error(
        "Course answer continuation emitted an invalid state update tool.",
      );
    }

    acceptedAnswerDecisionRef.current = decision;
    acceptedAnswerDecisionToolCallRef.current = normalizedToolCall;
    await input.onAnswerDecision?.(decision);
  };

  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: true,
    onTextDelta: input.onTextDelta,
    trace: {
      operation: "course_chat_turn",
      userId: input.userId,
      question: page.title,
    },
    async onToolCallDelta(toolCallDeltas) {
      mergeStreamingToolCallDeltas(streamedToolCalls, toolCallDeltas);

      for (const toolCall of streamedToolCalls) {
        await tryAcceptAnswerDecision(toolCall);

        if (
          !reportedQuestionWidgetToolDelta &&
          toolCall.function?.name === COURSE_QUESTION_WIDGET_TOOL_NAME
        ) {
          reportedQuestionWidgetToolDelta = true;
          input.onQuestionWidgetToolDelta?.();
        }
      }
    },
    body: request.requestBody,
  });

  if (!response.ok) {
    throw new Error("Course answer continuation failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, model);

  for (const toolCall of extractChatCompletionToolCalls(body)) {
    await tryAcceptAnswerDecision(toolCall);
  }

  if (!acceptedAnswerDecisionRef.current) {
    throw new Error("Course answer continuation did not emit a valid answer decision.");
  }

  const finalAnswerDecision = acceptedAnswerDecisionRef.current;
  const finalAnswerDecisionToolCall = acceptedAnswerDecisionToolCallRef.current;

  if (!finalAnswerDecisionToolCall) {
    throw new Error("Course answer continuation did not emit a valid state update tool.");
  }

  const responseText = extractChatCompletionText(body);
  const responseToolCalls = extractChatCompletionWidgetToolCalls(body);
  const responseWidgets = courseQuestionWidgetsFromToolCalls(responseToolCalls);
  const completesCourse =
    finalAnswerDecision.progressDecision.toolCall === "mark_milestone_done" &&
    !nextPage;

  if (completesCourse) {
    return {
      content:
        responseText.trim() ||
        "That completes the course. The generated questions are now available for Review.",
      toolCalls: [],
      answerDecisionToolCall: finalAnswerDecisionToolCall,
      answerDecision: finalAnswerDecision,
    };
  }

  if (!responseText.trim()) {
    throw new Error(COURSE_ANSWER_CONTINUATION_VISIBLE_TEXT_MISSING_ERROR_MESSAGE);
  }

  if (responseToolCalls.length === 0) {
    throw new Error(
      "Course answer continuation did not emit a question widget after the answer decision.",
    );
  }

  const ensuredTurn = ensureCourseChatTurnHasLearnerQuestion({
    text: responseText,
    widgets: responseWidgets,
    pageTitle:
      finalAnswerDecision.progressDecision.toolCall === "mark_milestone_done"
        ? (nextPage?.title ?? page.title)
        : page.title,
    pageObjective:
      finalAnswerDecision.progressDecision.toolCall === "mark_milestone_done"
        ? (nextPage?.objective ?? page.objective)
        : page.objective,
    stripTrailingPartialContent: didReachMaxCompletionTokens(
      body.usage,
      COURSE_CHAT_TURN_MAX_TOKENS,
    ),
  });
  const fallbackToolCalls = ensuredTurn.widgets.map((widget) =>
    courseQuestionWidgetToolCallFromWidget(widget),
  );

  return {
    content: ensuredTurn.text,
    toolCalls: responseToolCalls.length > 0 ? responseToolCalls : fallbackToolCalls,
    answerDecisionToolCall: finalAnswerDecisionToolCall,
    answerDecision: finalAnswerDecision,
  };
}

export async function streamCourseChatTurn(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  progressDecision?: CourseProgressDecision | null;
  onTextDelta: (delta: string) => void;
  onQuestionWidgetToolDelta?: () => void;
} & CourseCostObserver): Promise<{
  content: string;
  toolCalls: CourseQuestionWidgetToolCall[];
}> {
  if (input.course.status === "completed") {
    const message =
      "That completes the course. The generated questions are now available for Review.";

    input.onTextDelta(message);
    return {
      content: message,
      toolCalls: [],
    };
  }

  const runAttempt = async (
    retryInstruction: string | null,
  ): Promise<{
    content: string;
    toolCalls: CourseQuestionWidgetToolCall[];
  }> => {
    const startedAt = Date.now();
    let reportedQuestionWidgetToolDelta = false;
    const request = buildCourseChatTurnModelRequest({
      userId: input.userId,
      course: input.course,
      messages: input.messages,
      progressDecision: input.progressDecision,
      retryInstruction,
      model: input.model,
    });
    const { page } = request;
    const model = request.model;
    const { body, response } = await openRouterChatCompletion({
      apiKey: input.apiKey,
      stream: true,
      onTextDelta: input.onTextDelta,
      trace: {
        operation: "course_chat_turn",
        userId: input.userId,
        question: page.title,
      },
      onToolCallDelta() {
        if (reportedQuestionWidgetToolDelta) {
          return;
        }

        reportedQuestionWidgetToolDelta = true;
        input.onQuestionWidgetToolDelta?.();
      },
      body: request.requestBody,
    });

    if (!response.ok) {
      throw new Error("Course chat generation failed.");
    }

    reportResponseMetrics(input, body.usage, Date.now() - startedAt, model);

    const responseText = extractChatCompletionText(body);
    const responseToolCalls = extractChatCompletionWidgetToolCalls(body);
    const responseWidgets = courseQuestionWidgetsFromToolCalls(responseToolCalls);

    if (!responseText.trim()) {
      throw new CourseTutorTextMissingError();
    }

    const ensuredTurn = ensureCourseChatTurnHasLearnerQuestion({
      text: responseText,
      widgets: responseWidgets,
      pageTitle: page.title,
      pageObjective: page.objective,
      stripTrailingPartialContent: didReachMaxCompletionTokens(
        body.usage,
        COURSE_CHAT_TURN_MAX_TOKENS,
      ),
      requireVisibleTeachingTextWithWidgets: true,
    });

    if (ensuredTurn.appendedText) {
      input.onTextDelta(ensuredTurn.appendedText);
    }

    const ensuredToolCalls = ensuredTurn.widgets.map((widget, index) =>
      courseQuestionWidgetToolCallFromWidget(
        widget,
        responseToolCalls[index]?.id ?? `widget-call-${widget.id}`,
      ),
    );

    return {
      content: ensuredTurn.text,
      toolCalls: ensuredToolCalls,
    };
  };

  try {
    return await runAttempt(null);
  } catch (error) {
    if (!(error instanceof CourseTutorTextMissingError)) {
      throw error;
    }
  }

  return runAttempt(COURSE_CHAT_VISIBLE_TEXT_RETRY_INSTRUCTION);
}

export async function generateCourseToc(input: {
  apiKey: string;
  model?: string;
  topic: string;
  userId: string;
  onPartialToc?: (toc: PartialCourseToc) => void;
} & CourseCostObserver): Promise<CourseToc> {
  let streamedContent = "";
  let lastPartialSignature = "";
  const streamedToolCalls: Array<OpenRouterToolCall & { index?: number }> = [];
  const onTextDelta = input.onPartialToc
    ? (delta: string) => {
        streamedContent += delta;
        const partialToc = normalizePartialCourseToc(streamedContent);
        const partialSignature = JSON.stringify(partialToc);

        if (
          partialSignature !== lastPartialSignature &&
          (partialToc.title || partialToc.description || partialToc.pages.length > 0)
        ) {
          lastPartialSignature = partialSignature;
          input.onPartialToc?.(partialToc);
        }
      }
    : undefined;
  const startedAt = Date.now();
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: true,
    onTextDelta,
    trace: {
      operation: "course_toc",
      userId: input.userId,
      question: input.topic,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_LEARN_MODEL,
      temperature: 0.4,
      max_tokens: 1_800,
      tools: [COURSE_TOC_TOOL],
      tool_choice: {
        type: "function",
        function: { name: COURSE_TOC_TOOL_NAME },
      },
      parallel_tool_calls: false,
      messages: [
        {
          role: "system",
          content: loadPromptTemplate("course-toc-system.md"),
        },
        {
          role: "user",
          content: renderPromptTemplate(loadPromptTemplate("course-toc-user.md"), {
            topic: input.topic,
          }),
        },
      ],
    },
    onToolCallDelta(toolCallDeltas) {
      if (!input.onPartialToc) {
        return;
      }

      mergeStreamingToolCallDeltas(streamedToolCalls, toolCallDeltas);

      const tocToolCall = streamedToolCalls.find(
        (toolCall) => toolCall.function?.name === COURSE_TOC_TOOL_NAME,
      );
      const streamedArguments = tocToolCall?.function?.arguments ?? "";
      const partialToc = normalizePartialCourseToc(streamedArguments);
      const partialSignature = JSON.stringify(partialToc);

      if (
        partialSignature !== lastPartialSignature &&
        (partialToc.title || partialToc.description || partialToc.pages.length > 0)
      ) {
        lastPartialSignature = partialSignature;
        input.onPartialToc(partialToc);
      }
    },
  });

  if (!response.ok) {
    throw new Error("Course TOC generation failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  const tocToolCall = normalizeCourseToolCalls(
    extractChatCompletionToolCalls(body),
  ).find((toolCall) => toolCall.function.name === COURSE_TOC_TOOL_NAME);

  if (tocToolCall?.function.name === COURSE_TOC_TOOL_NAME) {
    return tocToolCall.function.arguments.toc;
  }

  return parseCourseTocJson(extractChatCompletionText(body));
}
