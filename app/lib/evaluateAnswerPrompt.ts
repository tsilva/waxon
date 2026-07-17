import { loadPromptTemplate } from "../../shared/prompt-templates.mts";

export function buildSystemPrompt(): string {
  return loadPromptTemplate("evaluate-answer-system.md");
}
