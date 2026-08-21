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

export type QuestionQualityAssessment = {
  passes: boolean;
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
    reasons.push("Add a question prompt.");
  } else {
    if (prompt.length < 8) {
      reasons.push("Make the prompt specific enough to identify the recall target.");
    }
    if (prompt.length > 16_384) {
      reasons.push("Split the prompt into smaller questions.");
    }
    if (!/[?？:]$/u.test(prompt)) {
      reasons.push("Phrase the prompt as a direct retrieval question.");
    }
    if (BROAD_PATTERNS.some((pattern) => pattern.test(prompt))) {
      reasons.push("Split this broad prompt into atomic recall questions.");
    }
    if (LEADING_PATTERNS.some((pattern) => pattern.test(prompt))) {
      reasons.push("Remove hints or leading language from the prompt.");
    }
  }

  if (!answer) {
    reasons.push("Add or confirm a reference answer.");
  } else if (answer.length > 65_536) {
    reasons.push("Reduce the answer or split the recall target.");
  }

  if (!target) {
    reasons.push("Identify the exact knowledge this question should retrieve.");
  }

  return { passes: reasons.length === 0, reasons };
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
