import { loadPromptTemplate } from "./promptTemplates.ts";

export function buildSystemPrompt(): string {
  return loadPromptTemplate("evaluate-answer-system.md");
}
