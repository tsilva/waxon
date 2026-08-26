import { createHash } from "node:crypto";
import {
  assessQuestionQuality,
  type QuestionQualityAssessment,
} from "./questionQuality.ts";

export const MAX_QUESTION_BATCH = 50;
export const MAX_PROMPT_CHARS = 16_384;
export const MAX_REFERENCE_ANSWER_CHARS = 65_536;

export type LeanQuestionInput = {
  prompt: string;
  referenceAnswer: string;
  importance?: number;
};

export type NormalizedQuestionInput = {
  prompt: string;
  referenceAnswer: string;
  importance: number;
  promptKey: string;
};

export function normalizeQuestionPrompt(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function questionPromptKey(value: string): string {
  return createHash("sha256").update(normalizeQuestionPrompt(value)).digest("hex");
}

export function normalizeQuestionInput(
  input: LeanQuestionInput,
  assessment?: QuestionQualityAssessment,
): NormalizedQuestionInput {
  const prompt = input.prompt.replace(/\s+/gu, " ").trim();
  const referenceAnswer = input.referenceAnswer.trim();
  const importance = Math.max(0.1, Math.min(5, input.importance ?? 1));
  const quality =
    assessment ??
    assessQuestionQuality({
      prompt,
      referenceAnswer,
      target: prompt,
    });

  if (!prompt) {
    throw new Error("Add a question prompt.");
  }
  if (!referenceAnswer) {
    throw new Error("Add or confirm an Answer Standard.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Question prompts must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  if (referenceAnswer.length > MAX_REFERENCE_ANSWER_CHARS) {
    throw new Error(
      `Answer Standards must be at most ${MAX_REFERENCE_ANSWER_CHARS} characters.`,
    );
  }
  if (!quality.passes) {
    throw new Error(quality.reasons.join(" "));
  }

  return {
    prompt,
    referenceAnswer,
    importance,
    promptKey: questionPromptKey(prompt),
  };
}
