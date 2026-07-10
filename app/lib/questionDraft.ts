import { questionSlug } from "./questionSlug.ts";

export type NormalizedQuestionDraft = {
  question: string;
  questionIdentity: string;
  conciseAnswer: string;
  questionProvenance: string;
  proposedConceptSlugs: string[];
  sourceText: string;
};

export type QuestionDraftLengthLimits = Partial<{
  question: number;
  conciseAnswer: number;
  questionProvenance: number;
  conceptSlug: number;
  sourceText: number;
}>;

const QUESTION_ALIASES = ["question", "q"] as const;
const CONCISE_ANSWER_ALIASES = ["conciseAnswer", "a"] as const;
const QUESTION_PROVENANCE_ALIASES = [
  "questionProvenance",
  "provenance",
  "p",
] as const;
const CONCEPT_SLUG_ARRAY_ALIASES = [
  "proposedConceptSlugs",
  "conceptSlugs",
] as const;
const CONCEPT_SLUG_ALIASES = [
  "proposedConceptSlug",
  "conceptSlug",
  "c",
] as const;

function firstString(
  record: Record<string, unknown>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    if (typeof record[alias] === "string") {
      return record[alias];
    }
  }

  return "";
}

function normalizeWhitespace(value: unknown, maxLength?: number): string {
  const normalized =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

  return maxLength === undefined ? normalized : normalized.slice(0, maxLength);
}

function normalizeSourceText(value: unknown, maxLength?: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";

  return maxLength === undefined ? normalized : normalized.slice(0, maxLength);
}

function normalizeConceptSlugs(
  record: Record<string, unknown>,
  maxLength?: number,
): string[] {
  let candidates: unknown[] = [];
  let foundArray = false;

  for (const alias of CONCEPT_SLUG_ARRAY_ALIASES) {
    if (Array.isArray(record[alias])) {
      candidates = record[alias];
      foundArray = true;
      break;
    }
  }

  if (!foundArray) {
    candidates = [firstString(record, CONCEPT_SLUG_ALIASES)];
  }

  return Array.from(
    new Set(
      candidates
        .map((candidate) => normalizeWhitespace(candidate, maxLength))
        .filter(Boolean),
    ),
  );
}

export function normalizeQuestionDraft(
  value: unknown,
  limits: QuestionDraftLengthLimits = {},
): NormalizedQuestionDraft | null {
  const record =
    typeof value === "string"
      ? { question: value }
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;

  if (!record) {
    return null;
  }

  const question = normalizeWhitespace(
    firstString(record, QUESTION_ALIASES),
    limits.question,
  );

  if (!question) {
    return null;
  }

  return {
    question,
    questionIdentity: questionSlug(question),
    conciseAnswer: normalizeWhitespace(
      firstString(record, CONCISE_ANSWER_ALIASES),
      limits.conciseAnswer,
    ),
    questionProvenance: normalizeWhitespace(
      firstString(record, QUESTION_PROVENANCE_ALIASES),
      limits.questionProvenance,
    ),
    proposedConceptSlugs: normalizeConceptSlugs(record, limits.conceptSlug),
    sourceText: normalizeSourceText(record.sourceText, limits.sourceText),
  };
}
