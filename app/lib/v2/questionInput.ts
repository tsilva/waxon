import { createHash } from "node:crypto";
import { assessQuestionQuality } from "./questionQuality.ts";
import type { V2AnswerMode } from "./types";

export const MAX_QUESTION_BATCH = 50;
export const MAX_PROMPT_CHARS = 16_384;
export const MAX_REFERENCE_ANSWER_CHARS = 65_536;

export type LeanQuestionInput = {
  prompt: string;
  referenceAnswer: string;
  answerMode?: V2AnswerMode;
  importance?: number;
};

export type NormalizedQuestionInput = {
  prompt: string;
  referenceAnswer: string;
  answerMode: V2AnswerMode;
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
): NormalizedQuestionInput {
  const prompt = input.prompt.replace(/\s+/gu, " ").trim();
  const referenceAnswer = input.referenceAnswer.trim();
  const answerMode =
    input.answerMode === "exact" || input.answerMode === "rubric"
      ? input.answerMode
      : "semantic";
  const importance = Math.max(0.1, Math.min(5, input.importance ?? 1));
  const quality = assessQuestionQuality({
    prompt,
    referenceAnswer,
    target: prompt,
  });

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Question prompts must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  if (referenceAnswer.length > MAX_REFERENCE_ANSWER_CHARS) {
    throw new Error(
      `Reference answers must be at most ${MAX_REFERENCE_ANSWER_CHARS} characters.`,
    );
  }
  if (!quality.passes) {
    throw new Error(quality.reasons.join(" "));
  }

  return {
    prompt,
    referenceAnswer,
    answerMode,
    importance,
    promptKey: questionPromptKey(prompt),
  };
}
