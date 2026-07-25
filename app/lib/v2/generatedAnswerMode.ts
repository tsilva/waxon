import type { V2AnswerMode } from "./types";

export function normalizeGeneratedAnswerMode(
  value: unknown,
): V2AnswerMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLocaleLowerCase("en-US");

  if (normalized === "exact") {
    return "exact";
  }
  if (["rubric", "multi-point", "multipoint"].includes(normalized)) {
    return "rubric";
  }
  if (
    [
      "semantic",
      "text",
      "free-text",
      "free_text",
      "explanation",
      "short",
      "long",
      "short-answer",
      "short_answer",
      "long-answer",
      "long_answer",
    ].includes(normalized)
  ) {
    return "semantic";
  }
  return null;
}
