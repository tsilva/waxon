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
import type { CourseDetail } from "./courseStore";

const COURSE_JSON_RESPONSE_FORMAT = { type: "json_object" };
const MAX_INTAKE_MESSAGE_CHARS = 500;
const MAX_INTAKE_TOPIC_CHARS = 800;

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

export type CourseProgressDecision =
  | {
      toolCall: "mark_milestone_done";
      reason: string;
    }
  | {
      toolCall: "continue_current_milestone";
      reason: string;
    };

function normalizeIntakeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
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
  const chapter = course.toc.chapters[course.currentChapterIndex];
  const page = chapter?.pages[course.currentPageIndex];

  if (!chapter || !page) {
    throw new Error("Course current position does not exist.");
  }

  return { chapter, page };
}

function compactCourseMessages(messages: CourseChatMessage[]) {
  return messages.slice(-10).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 1_200),
  }));
}

export function buildFallbackCourseToc(topic: string): CourseToc {
  const title = normalizeIntakeText(topic, 80) || "Focused Mini-Course";

  return {
    title,
    description: `A focused chat course about ${title}.`,
    chapters: [
      {
        title: "Core Model",
        pages: [
          {
            title: "Main Idea",
            objective: `State the central idea behind ${title}.`,
          },
          {
            title: "Working Parts",
            objective: `Explain the most important moving parts in ${title}.`,
          },
        ],
      },
      {
        title: "Practice",
        pages: [
          {
            title: "Apply It",
            objective: `Use ${title} in a small concrete example.`,
          },
          {
            title: "Check Understanding",
            objective: `Recognize a common mistake or limitation in ${title}.`,
          },
        ],
      },
    ],
  };
}

export async function generateCourseIntakeDecision(input: {
  apiKey: string;
  model?: string;
  userId: string;
  messages: CourseIntakeMessage[];
}): Promise<CourseIntakeDecision> {
  const compactMessages = input.messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.content.slice(0, MAX_INTAKE_TOPIC_CHARS),
  }));

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

  return parseCourseIntakeDecision(extractChatCompletionText(body));
}

export async function evaluateCourseChatProgress(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
}): Promise<CourseProgressDecision> {
  const { chapter, page } = currentCourseMilestone(input.course);
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_chat_progress",
      userId: input.userId,
      deckId: input.course.id,
      question: `${chapter.title}: ${page.title}`,
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
            "Use mark_milestone_done only when the learner correctly explains or selects the core idea.",
            "Use continue_current_milestone when the answer is missing, vague, wrong, or only partially correct.",
            "Return strict JSON only with shape {\"toolCall\":\"mark_milestone_done\"|\"continue_current_milestone\",\"reason\":\"...\"}.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Course title: ${input.course.title}`,
            `Current chapter: ${chapter.title}`,
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

  return parseCourseProgressDecision(extractChatCompletionText(body));
}

export async function streamCourseChatTurn(input: {
  apiKey: string;
  model?: string;
  userId: string;
  course: CourseDetail;
  messages: CourseChatMessage[];
  progressDecision?: CourseProgressDecision | null;
  onTextDelta: (delta: string) => void;
}): Promise<string> {
  if (input.course.status === "completed") {
    const message =
      "That completes the course. The generated questions are now available for Review.";

    input.onTextDelta(message);
    return message;
  }

  const { chapter, page } = currentCourseMilestone(input.course);
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: true,
    onTextDelta: input.onTextDelta,
    trace: {
      operation: "course_chat_turn",
      userId: input.userId,
      deckId: input.course.id,
      question: `${chapter.title}: ${page.title}`,
    },
    body: {
      model: input.model ?? DEFAULT_OPENROUTER_CHAT_MODEL,
      temperature: 0.5,
      max_tokens: 1_400,
      messages: [
        {
          role: "system",
          content: [
            "You are Waxon's Learn chat tutor.",
            "Run a milestone-driven course entirely inside chat.",
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
            "If the previous answer completed a milestone, briefly acknowledge it and move to the next milestone.",
            "If the previous answer did not complete the milestone, give concise corrective feedback and ask a smaller follow-up question.",
            "Do not mention tool calls or internal progress decisions.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Course title: ${input.course.title}`,
            `Course description: ${input.course.description}`,
            `Full TOC JSON: ${JSON.stringify(input.course.toc)}`,
            `Current chapter index: ${input.course.currentChapterIndex}`,
            `Current chapter: ${chapter.title}`,
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

  const generatedText = extractChatCompletionText(body);
  const hasLearnerQuestion =
    generatedText.includes("?") || /\bA\)\s+\S[\s\S]*\bB\)/u.test(generatedText);

  if (!hasLearnerQuestion) {
    const separator = /[.!?)]\s*$/u.test(generatedText.trim()) ? "\n\n" : ".\n\n";
    const fallbackQuestion = [
      `${separator}**Checkpoint**`,
      `Focus on this milestone: ${page.objective}`,
      "What is the main idea of this milestone in your own words?",
    ].join("\n\n");

    input.onTextDelta(fallbackQuestion);

    return `${generatedText}${fallbackQuestion}`;
  }

  return generatedText;
}

export async function generateCourseToc(input: {
  apiKey: string;
  model?: string;
  topic: string;
  userId: string;
}): Promise<CourseToc> {
  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
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
            "Return JSON with shape:",
            "{\"title\":\"...\",\"description\":\"...\",\"chapters\":[{\"title\":\"...\",\"pages\":[{\"title\":\"...\",\"objective\":\"...\"}]}]}",
            "Use 3-5 chapters, 2-4 pages per chapter, and no more than 16 total pages.",
            "Keep titles specific and useful for a learner.",
          ].join("\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error("Course TOC generation failed.");
  }

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
  const chapter = input.toc.chapters[input.chapterIndex];
  const page = chapter?.pages[input.pageIndex];

  if (!chapter || !page) {
    throw new Error("Course page position does not exist.");
  }

  const { body, response } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    stream: false,
    trace: {
      operation: "course_page",
      userId: input.userId,
      deckId: input.courseId,
      question: `${chapter.title}: ${page.title}`,
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
            `Current chapter index: ${input.chapterIndex}`,
            `Current chapter title: ${chapter.title}`,
            `Current page index: ${input.pageIndex}`,
            `Current page title: ${page.title}`,
            `Current page objective: ${page.objective}`,
            `Previous page summaries: ${input.previousSummaries.length > 0 ? input.previousSummaries.join(" | ") : "None"}`,
            "Return JSON with shape:",
            "{\"title\":\"...\",\"body\":\"markdown lesson body\",\"summary\":\"...\",\"toolCalls\":[{\"name\":\"render_multiple_choice\",\"arguments\":{\"type\":\"multiple_choice\",\"id\":\"page-check\",\"question\":\"open-ended question without answer choices\",\"choices\":[{\"id\":\"A\",\"text\":\"...\"},{\"id\":\"B\",\"text\":\"...\"},{\"id\":\"C\",\"text\":\"...\"},{\"id\":\"D\",\"text\":\"...\"}],\"correctChoiceId\":\"A\",\"correctAnswer\":\"exact text of correct choice\",\"explanation\":\"brief feedback for the correct answer\"}}]}",
            "The body should teach the page clearly in 350-700 words.",
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
