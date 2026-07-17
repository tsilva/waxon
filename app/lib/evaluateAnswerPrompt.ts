import { loadPromptTemplate } from "../../shared/prompt-templates.mjs";

export function buildSystemPrompt(): string {
  return loadPromptTemplate("evaluate-answer-system.md");
}
