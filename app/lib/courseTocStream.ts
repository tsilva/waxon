import { type CourseTocPage, MAX_COURSE_PAGES } from "./courseContent.ts";
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
        return normalizeText(JSON.parse(text.slice(valueStart, index + 1)), 320);
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
    const title = normalizeText(record.title, 120);
    const objective = normalizeText(record.objective, 260);

    if (title && objective) {
      pages.push({ title, objective });
    }

    if (pages.length >= MAX_COURSE_PAGES) {
      break;
    }
  }

  return {
    title: extractCompleteJsonStringProperty(text, "title"),
    description: extractCompleteJsonStringProperty(text, "description"),
    pages,
  };
}
