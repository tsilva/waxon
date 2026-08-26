import { createHash } from "node:crypto";
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
): NormalizedQuestionInput {
  if (typeof input?.prompt !== "string") {
    throw new Error("Question Prompt must be text.");
  }
  if (typeof input?.referenceAnswer !== "string") {
    throw new Error("Answer Standard must be text.");
  }
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Question prompts must be at most ${MAX_PROMPT_CHARS} characters.`);
  }
  if (input.referenceAnswer.length > MAX_REFERENCE_ANSWER_CHARS) {
    throw new Error(
      `Answer Standards must be at most ${MAX_REFERENCE_ANSWER_CHARS} characters.`,
    );
  }
  const prompt = input.prompt.replace(/\s+/gu, " ").trim();
  const referenceAnswer = input.referenceAnswer.trim();
  const importance = Math.max(0.1, Math.min(5, input.importance ?? 1));

  if (!prompt) {
    throw new Error("Add a question prompt.");
  }
  if (!referenceAnswer) {
    throw new Error("Add or confirm an Answer Standard.");
  }
  return {
    prompt,
    referenceAnswer,
    importance,
    promptKey: questionPromptKey(prompt),
  };
}
