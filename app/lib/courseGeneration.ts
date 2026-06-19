import {
  DEFAULT_OPENROUTER_CHAT_MODEL,
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import { extractJsonObject } from "./jsonObject";
import {
  parseCoursePageJson,
  parseCourseTocJson,
  type CoursePageContent,
  type CourseToc,
} from "./courseContent";
import {
  ensureCourseChatTurnHasLearnerQuestion,
  excerptCourseMessageForPrompt,
} from "./courseChatTurn.ts";
import {
  metricsFromOpenRouterUsage,
  type CourseMessageMetrics,
} from "./courseMessageMetrics";
import {
  parseCourseQuestionAttemptToolResult,
  type CourseQuestionAttemptToolResult,
} from "./courseQuestionAttemptParsing";
import {
  normalizePartialCourseToc,
  type PartialCourseToc,
} from "./courseTocStream.ts";
import type { CourseDetail } from "./courseStore";
import type { CourseProgressDecision } from "./courseProgress.ts";

const COURSE_JSON_RESPONSE_FORMAT = { type: "json_object" };
const MAX_INTAKE_MESSAGE_CHARS = 500;
const MAX_INTAKE_TOPIC_CHARS = 800;
const QUESTION_EVALUATION_SNIPPET_PATTERN =
  /^<!--\s*waxon:evaluation-snippet score=\d{1,2}\s*-->\s*/u;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const MODEL_CONTEXT_WINDOW_TOKENS: Array<{
  pattern: RegExp;
  tokens: number;
}> = [
  { pattern: /gemini-(?:1\.5|2(?:\.[05])?|3(?:\.[05])?)-flash/iu, tokens: 1_000_000 },
  { pattern: /gemini-(?:1\.5|2(?:\.[05])?|3(?:\.[05])?)-pro/iu, tokens: 1_000_000 },
  { pattern: /gpt-4\.1|gpt-5/iu, tokens: 1_000_000 },
  { pattern: /claude-(?:3\.5|3\.7|4|4\.5)/iu, tokens: 200_000 },
];

type CourseCostObserver = {
  onCost?: (cost: number) => void;
  onMetrics?: (metrics: CourseMessageMetrics) => void;
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
};

export type { CourseQuestionAttemptToolResult };

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

function resolveContextWindowTokens(model: string | undefined): number | null {
  const configuredLimit = process.env.LLM_CONTEXT_WINDOW_TOKENS?.trim();

  if (configuredLimit) {
    const parsedLimit = Number.parseInt(configuredLimit, 10);

    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      return parsedLimit;
    }
  }

  const modelName = (model ?? DEFAULT_OPENROUTER_CHAT_MODEL).trim();
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
      message.content.replace(QUESTION_EVALUATION_SNIPPET_PATTERN, ""),
      1_200,
    ),
  }));
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
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.25,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: [
            "You are the Waxon Learn course-intake assistant.",
            "Decide whether the user has given enough context to start a concise mini-course.",
            "Ask at most one clarifying question when scope, level, or goal is ambiguous.",
            "If the user already clarified or the request is specific enough, create the course topic prompt.",
            "Return strict JSON only.",
            "Use shape {\"action\":\"clarify\",\"message\":\"...\"} or {\"action\":\"create_course\",\"topic\":\"...\",\"message\":\"...\"}.",
          ].join(" "),
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
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.15,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: [
            "You are controlling Waxon's milestone progress tool.",
            "Decide whether the learner's latest answer shows enough understanding to finish the current TOC milestone.",
            "Be conservative: a learner should stay on the current milestone until they have clearly grasped its objective.",
            "Use mark_milestone_done only when the learner demonstrates the core idea with enough specificity to transfer it, such as a correct explanation in their own words or a correct selection plus a clear reason.",
            "Do not advance for a lucky multiple-choice letter, a keyword match, a vague answer, a partially correct answer, or an answer that omits the causal/mechanistic point of the milestone.",
            "Use continue_current_milestone when the learner needs more practice on the same topic; the next tutor turn should present the same milestone from a new angle and ask a different question.",
            "Return strict JSON only with shape {\"toolCall\":\"mark_milestone_done\"|\"continue_current_milestone\",\"reason\":\"...\"}.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Course title: ${input.course.title}`,
            `Current milestone: ${page.title}`,
            `Milestone objective: ${page.objective}`,
            `Conversation JSON: ${JSON.stringify(compactCourseMessages(input.messages))}`,
          ].join("\n"),
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
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: [
            "You are filling Waxon's server-side course question attempt tool.",
            "Look at the tutor's previous assistant message and the learner's latest user message.",
            "If the previous assistant message ended with a real learner-facing question and the latest user message answers it, return a record_course_question_attempt tool call.",
            "Write question as a self-contained free-response review prompt that tests the same idea as the learner-facing question.",
            "If the tutor question was multiple choice, rephrase it into a recall question instead of using words like choose, option, A/B/C/D, or answer choice.",
            "Grade the answer from 0 to 10 using normal Waxon review standards.",
            "Always write correctAnswer as the concise ideal answer to the tutor question, even when the learner was fully correct.",
            "Do not leave correctAnswer or conciseAnswer blank, null, generic, or omitted in a record_course_question_attempt call.",
            "If there is no answerable tutor question, or the user is asking a new unrelated course-management question, skip.",
            "Return strict JSON only.",
            "Record shape: {\"toolCall\":\"record_course_question_attempt\",\"question\":\"...\",\"answer\":\"...\",\"answerSummary\":\"...\",\"conciseAnswer\":\"...\",\"correctAnswer\":\"...\",\"justification\":\"...\",\"score\":number}.",
            "Skip shape: {\"toolCall\":\"skip_course_question_attempt\",\"reason\":\"...\"}.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Course title: ${input.course.title}`,
            `Current milestone: ${page.title}`,
            `Milestone objective: ${page.objective}`,
            `Previous assistant message:\n${excerptCourseMessageForPrompt(previousAssistantMessage.content, 4_000)}`,
            `Latest learner answer:\n${excerptCourseMessageForPrompt(latestUserMessage.content, 4_000)}`,
          ].join("\n\n"),
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
    previousAssistantMessage.content,
  );
}

export async function streamCourseChatTurn(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  progressDecision?: CourseProgressDecision | null;
  onTextDelta: (delta: string) => void;
} & CourseCostObserver): Promise<string> {
  if (input.course.status === "completed") {
    const message =
      "That completes the course. The generated questions are now available for Review.";

    input.onTextDelta(message);
    return message;
  }

  const { page } = currentCourseMilestone(input.course);
  const startedAt = Date.now();
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: true,
    onTextDelta: input.onTextDelta,
    trace: {
      operation: "course_chat_turn",
      userId: input.userId,
      question: page.title,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      temperature: 0.5,
      max_tokens: 2_200,
      messages: [
        {
          role: "system",
          content: [
            "You are Waxon's Learn chat tutor.",
            "Run a milestone-driven course entirely inside chat.",
            "Maximize the probability that a learner at any knowledge level can understand the explanation deeply.",
            "Start from concrete intuition and plain language, define necessary jargon before relying on it, and make every causal or mathematical step feel motivated.",
            "When a prerequisite idea is needed, add a one-sentence bridge instead of assuming the learner already knows it.",
            "Connect three layers whenever useful: the intuitive picture, the precise technical claim, and a small example.",
            "Keep the explanation approachable without removing the real concept or hiding important mechanics.",
            "Be a great tutor: explain the intuition first, then the mechanics, then a small concrete example when useful.",
            "Use metaphors and analogies when they make the idea easier, but keep them technically accurate and brief.",
            "Do not compress the explanation into a dense summary. Teach enough for a motivated learner to build a mental model.",
            "Use markdown for readability: short headings, **bold** key terms, bullets for moving parts, and inline code or math notation for shapes/formulas.",
            "Prefer this shape: a short heading, 1-2 explanatory paragraphs, an **Analogy** or **Example** paragraph when helpful, then a tiny bullet list of the key pieces.",
            "Avoid markdown tables.",
            "Keep each teaching turn focused: usually 160-280 words before the question, and never more than one milestone at a time.",
            "Do not ask rhetorical questions inside the teaching snippet.",
            "Separate the teaching snippet from the final learner question with one blank line.",
            "Do not put a question mark anywhere before the final learner-facing question.",
            "End every turn with exactly one learner-facing question, and make it the final sentence or final multiple-choice block.",
            "Questions can be short free-response or multiple choice.",
            "If multiple choice, write choices directly in chat as A), B), C), D). Do not use widgets, JSON, markdown tables, or hidden metadata.",
            "If the progress tool says the previous answer completed a milestone, briefly acknowledge it and move to the next milestone.",
            "If the progress tool says the previous answer did not complete the milestone, do not advance. Stay on the same milestone, reteach the same topic from a different angle, and ask a different targeted question that tests the same objective.",
            "Do not mention tool calls or internal progress decisions.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Course title: ${input.course.title}`,
            `Course description: ${input.course.description}`,
            `Full TOC JSON: ${JSON.stringify(input.course.toc)}`,
            `Current milestone index: ${input.course.currentPageIndex}`,
            `Current milestone: ${page.title}`,
            `Milestone objective: ${page.objective}`,
            input.progressDecision
              ? `Progress tool result: ${input.progressDecision.toolCall} - ${input.progressDecision.reason}`
              : "Progress tool result: starting or continuing current milestone.",
            `Recent conversation JSON: ${JSON.stringify(compactCourseMessages(input.messages))}`,
          ].join("\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course chat generation failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  const ensuredTurn = ensureCourseChatTurnHasLearnerQuestion({
    text: extractChatCompletionText(body),
    pageTitle: page.title,
    pageObjective: page.objective,
  });

  if (ensuredTurn.appendedText) {
    input.onTextDelta(ensuredTurn.appendedText);
  }

  return ensuredTurn.text;
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
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.4,
      max_tokens: 1_800,
      messages: [
        {
          role: "system",
          content:
            "You design concise adaptive mini-courses for Waxon. Return strict JSON only.",
        },
        {
          role: "user",
          content: [
            `Topic: ${input.topic}`,
            "Create a mini-course table of contents.",
            "The TOC must be flat. Do not group pages into chapters or sections.",
            "Return JSON with shape:",
            "{\"title\":\"...\",\"description\":\"...\",\"pages\":[{\"title\":\"...\",\"objective\":\"...\"}]}",
            "Use 6-12 pages, and no more than 16 total pages.",
            "Keep titles specific and useful for a learner.",
          ].join("\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course TOC generation failed.");
  }

  reportResponseMetrics(input, body.usage, Date.now() - startedAt, input.model);

  return parseCourseTocJson(extractChatCompletionText(body));
}

export async function generateCoursePage(input: {
  apiKey: string;
  model?: string;
  userId: string;
  courseId: string;
  topic: string;
  toc: CourseToc;
  chapterIndex: number;
  pageIndex: number;
  previousSummaries: string[];
}): Promise<CoursePageContent> {
  const page = input.toc.pages[input.pageIndex];

  if (input.chapterIndex !== 0 || !page) {
    throw new Error("Course page position does not exist.");
  }

  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_page",
      userId: input.userId,
      question: page.title,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      response_format: COURSE_JSON_RESPONSE_FORMAT,
      temperature: 0.45,
      max_tokens: 2_800,
      messages: [
        {
          role: "system",
          content:
            "You write one page of a Waxon mini-course. Return strict JSON only. Generate only the requested page. Interactive widgets must be emitted as UI tool calls, not embedded in prose.",
        },
        {
          role: "user",
          content: [
            `Original topic: ${input.topic}`,
            `Full course TOC JSON: ${JSON.stringify(input.toc)}`,
            `Current page index: ${input.pageIndex}`,
            `Current page title: ${page.title}`,
            `Current page objective: ${page.objective}`,
            `Previous page summaries: ${input.previousSummaries.length > 0 ? input.previousSummaries.join(" | ") : "None"}`,
            "Return JSON with shape:",
            "{\"title\":\"...\",\"body\":\"markdown lesson body\",\"summary\":\"...\",\"proposedConceptSlugs\":[\"concept-slug\"],\"toolCalls\":[{\"name\":\"render_multiple_choice\",\"arguments\":{\"type\":\"multiple_choice\",\"id\":\"page-check\",\"question\":\"open-ended question without answer choices\",\"choices\":[{\"id\":\"A\",\"text\":\"...\"},{\"id\":\"B\",\"text\":\"...\"},{\"id\":\"C\",\"text\":\"...\"},{\"id\":\"D\",\"text\":\"...\"}],\"correctChoiceId\":\"A\",\"correctAnswer\":\"exact text of correct choice\",\"explanation\":\"brief feedback for the correct answer\"}}]}",
            "The body should teach the page clearly in 350-700 words.",
            "proposedConceptSlugs must contain 1-3 full self-disambiguating lowercase kebab-case concept slugs tested by the page question.",
            "Call the render_multiple_choice UI tool exactly once in toolCalls.",
            "The tool-call question must be usable later as a free-response review prompt, so do not include A/B/C/D choices in the question text.",
            "Do not mention the answer choices in the lesson body.",
            "Use exactly four answer choices with ids A, B, C, D.",
            "The correctAnswer must exactly match the correct choice text.",
          ].join("\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course page generation failed.");
  }

  return parseCoursePageJson(extractChatCompletionText(body));
}
