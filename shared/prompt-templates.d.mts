export function loadPromptTemplate(name: string): string;

export function renderPromptTemplate(
  template: string,
  replacements: Record<string, string | number | null | undefined>,
): string;
