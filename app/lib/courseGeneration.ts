import {
  DEFAULT_OPENROUTER_CHAT_MODEL,
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import {
  parseCoursePageJson,
  parseCourseTocJson,
  type CoursePageContent,
  type CourseToc,
} from "./courseContent";

const COURSE_JSON_RESPONSE_FORMAT = { type: "json_object" };

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
            "You write one page of a Waxon mini-course. Return strict JSON only. Generate only the requested page.",
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
            "{\"title\":\"...\",\"body\":\"markdown lesson body\",\"summary\":\"...\",\"question\":\"open-ended question without answer choices\",\"choices\":[{\"id\":\"A\",\"text\":\"...\"},{\"id\":\"B\",\"text\":\"...\"},{\"id\":\"C\",\"text\":\"...\"},{\"id\":\"D\",\"text\":\"...\"}],\"correctChoiceId\":\"A\",\"correctAnswer\":\"exact text of correct choice\",\"explanation\":\"brief feedback for the correct answer\"}",
            "The body should teach the page clearly in 350-700 words.",
            "The question must be usable later as a free-response review prompt, so do not include A/B/C/D choices in the question text.",
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
