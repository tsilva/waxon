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
