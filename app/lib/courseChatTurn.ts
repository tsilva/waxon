export function ensureCourseChatTurnHasLearnerQuestion(input: {
  text: string;
  pageTitle: string;
  pageObjective: string;
}): {
  text: string;
  appendedText: string;
} {
  const generatedText = input.text.trim();
  const hasLearnerQuestion =
    generatedText.includes("?") || /\bA\)\s+\S[\s\S]*\bB\)/u.test(generatedText);

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
