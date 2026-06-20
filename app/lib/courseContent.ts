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

const MAX_COURSE_TITLE_CHARS = 90;
const MAX_COURSE_DESCRIPTION_CHARS = 320;
export const MAX_COURSE_PAGES = 16;
const MAX_PAGE_TITLE_CHARS = 120;
const MAX_OBJECTIVE_CHARS = 260;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
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

export function coursePageCount(toc: CourseToc): number {
  return toc.pages.length;
}

export function nextCoursePosition(input: {
  toc: CourseToc;
  chapterIndex: number;
  pageIndex: number;
}): { chapterIndex: number; pageIndex: number } | null {
  if (input.chapterIndex !== 0 || !input.toc.pages[input.pageIndex]) {
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
