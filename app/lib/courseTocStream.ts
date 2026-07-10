import {
  COURSE_TOC_LIMITS,
  type CourseTocPage,
} from "./courseContent.ts";
import { extractCompleteJsonObjectsFromArrayProperty } from "./streamedJsonArray.ts";

export type PartialCourseToc = {
  title: string;
  description: string;
  pages: CourseTocPage[];
};

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function extractCompleteJsonStringProperty(
  text: string,
  propertyName: string,
): string {
  const escapedPropertyName = propertyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`"${escapedPropertyName}"\\s*:\\s*"`, "u").exec(text);

  if (!match) {
    return "";
  }

  const valueStart = match.index + match[0].length - 1;
  let isEscaped = false;

  for (let index = valueStart + 1; index < text.length; index += 1) {
    const char = text[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === "\"") {
      try {
        return normalizeText(
          JSON.parse(text.slice(valueStart, index + 1)),
          propertyName === "title"
            ? COURSE_TOC_LIMITS.titleChars
            : COURSE_TOC_LIMITS.descriptionChars,
        );
      } catch {
        return "";
      }
    }
  }

  return "";
}

export function normalizePartialCourseToc(text: string): PartialCourseToc {
  const pages: CourseTocPage[] = [];

  for (const rawPage of extractCompleteJsonObjectsFromArrayProperty(
    text,
    "pages",
  )) {
    if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) {
      continue;
    }

    const record = rawPage as Record<string, unknown>;
    const title = normalizeText(
      record.title,
      COURSE_TOC_LIMITS.pageTitleChars,
    );
    const objective = normalizeText(
      record.objective,
      COURSE_TOC_LIMITS.objectiveChars,
    );

    if (title && objective) {
      pages.push({ title, objective });
    }

    if (pages.length >= COURSE_TOC_LIMITS.pages) {
      break;
    }
  }

  return {
    title: extractCompleteJsonStringProperty(text, "title"),
    description: extractCompleteJsonStringProperty(text, "description"),
    pages,
  };
}
