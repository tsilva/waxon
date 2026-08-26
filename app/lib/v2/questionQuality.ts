import { createHash } from "node:crypto";

const BROAD_PATTERNS = [
  /\b(explain|describe|discuss)\s+(everything|all|the whole)\b/iu,
  /\bwhat (?:do you know|can you say) about\b/iu,
  /\bcompare\b.+\band\b.+\band\b/iu,
];

const LEADING_PATTERNS = [
  /\b(?:isn't it|right\?|obviously|of course)\b/iu,
  /\bfill in the blank\b/iu,
];

const CONTEXT_DEPENDENT_PATTERNS = [
  /\b(?:shown|mentioned|described|provided)\s+(?:above|below)\b/iu,
  /\b(?:above|below|attached|provided)\s+(?:diagram|document|image|passage|source|text)\b/iu,
  /\b(?:the|this)\s+(?:diagram|document|image|passage|source)\b/iu,
  /\bthe\s+(?:company|organization|project|system)\b/iu,
  /\bdoes\s+it\s+mean\s*\?$/iu,
  /\b(?:is|are|was|were)\s+(?:it|this|that|they|these|those)(?:\s+and\s+(?:why|how|what|when|where|who))?\s*\?$/iu,
];

const UNANSWERABLE_STANDARD_PATTERNS = [
  /^(?:i\s+)?(?:do not|don't) know[.!]?$/iu,
  /^(?:it depends|n\/?a|not applicable|not sure|tbd|unknown)[.!]?$/iu,
];

const QUALITY_TERM_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);

function qualityTerms(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => !QUALITY_TERM_STOP_WORDS.has(term)) ?? [];
}

function answerOnlyRestatesPrompt(prompt: string, answer: string): boolean {
  if (!/^\s*(?:a|an|the)\s+/iu.test(answer)) {
    return false;
  }

  const promptTerms = qualityTerms(prompt);
  const answerTerms = qualityTerms(answer);
  return (
    answerTerms.length > 0 &&
    answerTerms.length <= promptTerms.length &&
    answerTerms.every(
      (term, index) =>
        term === promptTerms[promptTerms.length - answerTerms.length + index],
    )
  );
}

export type QuestionQualityOutcome =
  | "pass"
  | "fail"
  | "inconclusive"
  | "unavailable";

export type QuestionQualityAssessment = {
  outcome: QuestionQualityOutcome;
  reasons: string[];
};

export function assessQuestionQuality(input: {
  prompt: string;
  referenceAnswer: string;
  target: string;
}): QuestionQualityAssessment {
  const prompt = input.prompt.trim();
  const answer = input.referenceAnswer.trim();
  const target = input.target.trim();
  const reasons: string[] = [];

  if (!prompt) {
    reasons.push("missing_prompt");
  } else {
    if (prompt.length < 8) {
      reasons.push("prompt_too_vague");
    }
    if (!/[?？:]$/u.test(prompt)) {
      reasons.push("not_recall_oriented");
    }
    if (BROAD_PATTERNS.some((pattern) => pattern.test(prompt))) {
      reasons.push("not_atomic");
    }
    if (LEADING_PATTERNS.some((pattern) => pattern.test(prompt))) {
      reasons.push("leading_prompt");
    }
    if (
      CONTEXT_DEPENDENT_PATTERNS.some((pattern) => pattern.test(prompt))
    ) {
      reasons.push("not_self_contained");
    }
  }

  if (!answer) {
    reasons.push("missing_answer_standard");
  } else if (
    UNANSWERABLE_STANDARD_PATTERNS.some((pattern) => pattern.test(answer)) ||
    answerOnlyRestatesPrompt(prompt, answer)
  ) {
    reasons.push("not_answerable");
  }

  if (!target) {
    reasons.push("missing_recall_target");
  }

  return { outcome: reasons.length > 0 ? "fail" : "pass", reasons };
}

export function normalizeRecallTarget(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function recallTargetKey(target: string): string {
  return createHash("sha256")
    .update(normalizeRecallTarget(target))
    .digest("hex");
}
