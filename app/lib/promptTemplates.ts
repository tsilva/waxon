import { readFileSync } from "node:fs";
import path from "node:path";

const PROMPT_ROOT = path.join(process.cwd(), "prompts");

export function loadPromptTemplate(name: string): string {
  return readFileSync(path.join(PROMPT_ROOT, name), "utf8").trimEnd();
}

export function renderPromptTemplate(
  template: string,
  replacements: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/gu, (_, key: string) =>
    String(replacements[key] ?? ""),
  );
}
