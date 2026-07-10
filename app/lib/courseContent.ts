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

export const COURSE_TOC_LIMITS = {
  titleChars: 90,
  descriptionChars: 320,
  pages: 16,
  pageTitleChars: 120,
  objectiveChars: 260,
} as const;

export const STORED_COURSE_TOC_LIMITS = {
  topicChars: 800,
  titleChars: 240,
  descriptionChars: 1_200,
  pageTitleChars: 240,
  objectiveChars: 1_200,
} as const;

export const MAX_COURSE_PAGES = COURSE_TOC_LIMITS.pages;

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
  const title = truncateText(
    normalizeText(record.title),
    COURSE_TOC_LIMITS.titleChars,
  );
  const description = truncateText(
    normalizeText(record.description),
    COURSE_TOC_LIMITS.descriptionChars,
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
      COURSE_TOC_LIMITS.pageTitleChars,
    );
    const objective = truncateText(
      normalizeText(page.objective),
      COURSE_TOC_LIMITS.objectiveChars,
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
  pageIndex: number;
}): { pageIndex: number } | null {
  if (!input.toc.pages[input.pageIndex]) {
    return null;
  }

  if (input.pageIndex + 1 < input.toc.pages.length) {
    return {
      pageIndex: input.pageIndex + 1,
    };
  }

  return null;
}
