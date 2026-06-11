import { extractJsonObject } from "./jsonObject.ts";

export type CourseTocPage = {
  title: string;
  objective: string;
};

export type CourseToc = {
  title: string;
  description: string;
  pages: CourseTocPage[];
};

export type CourseChoice = {
  id: string;
  text: string;
};

export type CourseMultipleChoiceWidget = {
  type: "multiple_choice";
  id: string;
  question: string;
  choices: CourseChoice[];
  correctChoiceId: string;
  correctAnswer: string;
  explanation: string;
};

export type CoursePageContent = {
  title: string;
  body: string;
  summary: string;
  question: string;
  choices: CourseChoice[];
  correctChoiceId: string;
  correctAnswer: string;
  explanation: string;
  widget: CourseMultipleChoiceWidget;
};

const MAX_COURSE_TITLE_CHARS = 90;
const MAX_COURSE_DESCRIPTION_CHARS = 320;
export const MAX_COURSE_PAGES = 16;
const MAX_PAGE_TITLE_CHARS = 120;
const MAX_OBJECTIVE_CHARS = 260;
const MAX_PAGE_BODY_CHARS = 8_000;
const MAX_PAGE_SUMMARY_CHARS = 700;
const MAX_PAGE_QUESTION_CHARS = 1_200;
const MAX_CHOICE_TEXT_CHARS = 500;
const MAX_EXPLANATION_CHARS = 1_200;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeMarkdown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trim();
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }

  return value;
}

function readOptionalArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseCourseTocJson(source: string): CourseToc {
  return validateCourseToc(extractJsonObject(source));
}

export function validateCourseToc(value: unknown): CourseToc {
  const record = readObject(value);
  const title = truncateText(normalizeText(record.title), MAX_COURSE_TITLE_CHARS);
  const description = truncateText(
    normalizeText(record.description),
    MAX_COURSE_DESCRIPTION_CHARS,
  );

  if (!title) {
    throw new Error("Course title is required.");
  }

  const rawPages = Array.isArray(record.pages)
    ? record.pages
    : readOptionalArray(record.chapters).flatMap((rawChapter) => {
        const chapter = readObject(rawChapter);
        return readOptionalArray(chapter.pages);
      });
  const pages: CourseTocPage[] = [];

  for (const rawPage of rawPages) {
    if (pages.length >= MAX_COURSE_PAGES) {
      break;
    }

    const page = readObject(rawPage);
    const pageTitle = truncateText(
      normalizeText(page.title),
      MAX_PAGE_TITLE_CHARS,
    );
    const objective = truncateText(
      normalizeText(page.objective),
      MAX_OBJECTIVE_CHARS,
    );

    if (pageTitle && objective) {
      pages.push({ title: pageTitle, objective });
    }
  }

  if (pages.length === 0) {
    throw new Error("Course TOC must include at least one page.");
  }

  return {
    title,
    description,
    pages,
  };
}

function hasEmbeddedChoices(question: string, choices: CourseChoice[]): boolean {
  if (/(^|[\s\n\r])(?:[A-D]|\d+)[).:-]\s+\S/iu.test(question)) {
    return true;
  }

  const lowerQuestion = question.toLowerCase();
  const embeddedChoiceCount = choices.filter((choice) =>
    lowerQuestion.includes(choice.text.toLowerCase()),
  ).length;

  return embeddedChoiceCount >= 2;
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return readObject(extractJsonObject(value));
  }

  return readObject(value);
}

function normalizeToolCall(value: unknown): {
  name: string;
  arguments: Record<string, unknown>;
} | null {
  const record = readObject(value);
  const functionRecord =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : null;
  const name = normalizeText(record.name ?? functionRecord?.name);
  const rawArguments = record.arguments ?? functionRecord?.arguments;

  if (!name && normalizeText(record.type) === "multiple_choice") {
    return {
      name: "render_multiple_choice",
      arguments: record,
    };
  }

  if (!name || rawArguments === undefined) {
    return null;
  }

  return {
    name,
    arguments: parseToolCallArguments(rawArguments),
  };
}

function readMultipleChoiceWidget(record: Record<string, unknown>) {
  const toolCallSources = [
    ...readOptionalArray(record.toolCalls),
    ...readOptionalArray(record.tool_calls),
    ...readOptionalArray(record.widgets),
  ];

  for (const rawToolCall of toolCallSources) {
    const toolCall = normalizeToolCall(rawToolCall);

    if (toolCall?.name === "render_multiple_choice") {
      return toolCall.arguments;
    }
  }

  return record;
}

export function parseCoursePageJson(source: string): CoursePageContent {
  return validateCoursePageContent(extractJsonObject(source));
}

export function validateCoursePageContent(value: unknown): CoursePageContent {
  const record = readObject(value);
  const widgetRecord = readMultipleChoiceWidget(record);
  const title = truncateText(normalizeText(record.title), MAX_PAGE_TITLE_CHARS);
  const body = truncateText(normalizeMarkdown(record.body), MAX_PAGE_BODY_CHARS);
  const summary = truncateText(
    normalizeText(record.summary),
    MAX_PAGE_SUMMARY_CHARS,
  );
  const question = truncateText(
    normalizeText(widgetRecord.question),
    MAX_PAGE_QUESTION_CHARS,
  );
  const rawChoices = readArray(widgetRecord.choices, "choices");
  const correctChoiceId = normalizeText(
    widgetRecord.correctChoiceId,
  ).toUpperCase();
  const correctAnswer = truncateText(
    normalizeText(widgetRecord.correctAnswer),
    MAX_CHOICE_TEXT_CHARS,
  );
  const explanation = truncateText(
    normalizeText(widgetRecord.explanation),
    MAX_EXPLANATION_CHARS,
  );

  if (!title || !body || !summary || !question) {
    throw new Error("Course page requires title, body, summary, and question.");
  }

  if (rawChoices.length !== 4) {
    throw new Error("Course page must include exactly 4 choices.");
  }

  const seenChoiceIds = new Set<string>();
  const choices = rawChoices.map((rawChoice) => {
    const choice = readObject(rawChoice);
    const id = normalizeText(choice.id).toUpperCase();
    const text = truncateText(normalizeText(choice.text), MAX_CHOICE_TEXT_CHARS);

    if (!id || !text) {
      throw new Error("Each choice requires an id and text.");
    }

    if (seenChoiceIds.has(id)) {
      throw new Error("Choice ids must be unique.");
    }

    seenChoiceIds.add(id);
    return { id, text };
  });

  const correctChoice = choices.find((choice) => choice.id === correctChoiceId);

  if (!correctChoice) {
    throw new Error("correctChoiceId must match one of the choices.");
  }

  if (!correctAnswer || correctAnswer !== correctChoice.text) {
    throw new Error("correctAnswer must match the correct choice text.");
  }

  if (hasEmbeddedChoices(question, choices)) {
    throw new Error("Question must not include multiple-choice options.");
  }

  const widget: CourseMultipleChoiceWidget = {
    type: "multiple_choice",
    id: normalizeText(widgetRecord.id) || "page-check",
    question,
    choices,
    correctChoiceId,
    correctAnswer,
    explanation,
  };

  return {
    title,
    body,
    summary,
    question,
    choices,
    correctChoiceId,
    correctAnswer,
    explanation,
    widget,
  };
}

export function coursePageCount(toc: CourseToc): number {
  return toc.pages.length;
}

export function coursePositionExists(input: {
  toc: CourseToc;
  chapterIndex: number;
  pageIndex: number;
}): boolean {
  return input.chapterIndex === 0 && Boolean(input.toc.pages[input.pageIndex]);
}

export function nextCoursePosition(input: {
  toc: CourseToc;
  chapterIndex: number;
  pageIndex: number;
}): { chapterIndex: number; pageIndex: number } | null {
  if (!coursePositionExists(input)) {
    return null;
  }

  if (input.pageIndex + 1 < input.toc.pages.length) {
    return {
      chapterIndex: 0,
      pageIndex: input.pageIndex + 1,
    };
  }

  return null;
}

export function flatCoursePageIndex(input: {
  tocValue: unknown;
  chapterIndex: number;
  pageIndex: number;
}): number {
  const record = readObject(input.tocValue);

  if (Array.isArray(record.pages)) {
    return Math.max(0, input.pageIndex);
  }

  const rawChapters = readOptionalArray(record.chapters);
  let index = Math.max(0, input.pageIndex);

  for (
    let chapterIndex = 0;
    chapterIndex < Math.max(0, input.chapterIndex);
    chapterIndex += 1
  ) {
    const chapter = rawChapters[chapterIndex];

    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) {
      continue;
    }

    index += readOptionalArray((chapter as Record<string, unknown>).pages).length;
  }

  return index;
}
