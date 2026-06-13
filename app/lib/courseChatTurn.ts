export function ensureCourseChatTurnHasLearnerQuestion(input: {
  text: string;
  pageTitle: string;
  pageObjective: string;
}): {
  text: string;
  appendedText: string;
} {
  const generatedText = input.text.trim();
  const hasLearnerQuestion = isCourseChatTurnComplete(generatedText);

  if (hasLearnerQuestion) {
    return {
      text: generatedText,
      appendedText: "",
    };
  }

  if (!generatedText) {
    const fallbackLesson = [
      `## ${input.pageTitle}`,
      `Start with this milestone: ${input.pageObjective}`,
      "A good answer should name the core idea, explain why it matters, and connect it to a small example.",
      "**Checkpoint**",
      "What is the main idea of this milestone in your own words?",
    ].join("\n\n");

    return {
      text: fallbackLesson,
      appendedText: fallbackLesson,
    };
  }

  const separator = /[.!?)]\s*$/u.test(generatedText) ? "\n\n" : ".\n\n";
  const fallbackQuestion = [
    `${separator}**Checkpoint**`,
    `Focus on this milestone: ${input.pageObjective}`,
    "What is the main idea of this milestone in your own words?",
  ].join("\n\n");

  return {
    text: `${generatedText}${fallbackQuestion}`,
    appendedText: fallbackQuestion,
  };
}

export function excerptCourseMessageForPrompt(
  content: string,
  maxLength: number,
): string {
  const normalizedContent = content.trim();

  if (
    normalizedContent.length <= maxLength ||
    !Number.isFinite(maxLength) ||
    maxLength < 80
  ) {
    return normalizedContent;
  }

  const marker = "\n\n... [middle omitted] ...\n\n";
  const remainingLength = Math.max(maxLength - marker.length, 1);
  const headLength = Math.ceil(remainingLength / 2);
  const tailLength = Math.floor(remainingLength / 2);

  return `${normalizedContent.slice(0, headLength)}${marker}${normalizedContent.slice(-tailLength)}`;
}

export function isCourseChatTurnComplete(text: string): boolean {
  const normalizedText = text.trim();

  if (!normalizedText) {
    return false;
  }

  if (/that completes the course\./iu.test(normalizedText)) {
    return true;
  }

  if (/[?]\s*$/u.test(normalizedText)) {
    return true;
  }

  const lastLines = normalizedText
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);
  const multipleChoiceLabels = new Set<string>();

  for (const line of lastLines) {
    const match = /^([A-D])\)\s+\S/u.exec(line);

    if (match?.[1]) {
      multipleChoiceLabels.add(match[1]);
    }
  }

  return multipleChoiceLabels.has("A") && multipleChoiceLabels.has("B");
}

export function shouldShowCourseChatInterruptedWarning(input: {
  role: "assistant" | "user";
  content: string;
  isEvaluationSnippet?: boolean;
  hasLaterStoredMessage?: boolean;
}): boolean {
  if (
    input.role !== "assistant" ||
    input.isEvaluationSnippet ||
    input.hasLaterStoredMessage
  ) {
    return false;
  }

  return !isCourseChatTurnComplete(input.content);
}
