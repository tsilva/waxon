import { readFileSync } from "node:fs";
import { join } from "node:path";

export const QUESTION_QUALITY_REFERENCE_PATH = "reference/question-quality.md";

let cachedQuestionQualityReference: string | null = null;

export function getQuestionQualityReference(): string {
  cachedQuestionQualityReference ??= readFileSync(
    join(process.cwd(), QUESTION_QUALITY_REFERENCE_PATH),
    "utf8",
  ).trim();

  return cachedQuestionQualityReference;
}
