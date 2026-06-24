import {
  parseCourseQuestionWidgets,
  serializeCourseQuestionWidget,
} from "./courseQuestionWidget.ts";

const PARTIAL_QUESTION_WIDGET_PATTERN =
  /<!--\s*waxon:question-widget\b[\s\S]*$/u;

export function ensureCourseChatTurnHasLearnerQuestion(input: {
  text: string;
  pageTitle: string;
  pageObjective: string;
  stripTrailingPartialContent?: boolean;
}): {
  text: string;
  appendedText: string;
} {
  const generatedText = input.text.trim();
  const parsedGeneratedTurn = parseCourseQuestionWidgets(generatedText);
  const hasLearnerQuestion = isCourseChatTurnComplete(generatedText);
  const fallbackWidget = serializeCourseQuestionWidget({
    type: "free_text",
    id: "fallback-milestone-check",
    question: "What is the main idea of this milestone in your own words?",
    placeholder: "Explain the idea in your own words...",
  });

  if (parsedGeneratedTurn.widgets.length > 0) {
    const cleanedVisibleContent = stripInvalidRepairParagraphs(
      parsedGeneratedTurn.content.trim(),
    );
    const sanitizedVisibleContent =
      stripDanglingTailIfNeeded(cleanedVisibleContent) ||
      `This milestone is about ${input.pageObjective}`;
    const widgetText = parsedGeneratedTurn.widgets
      .map((widget) => serializeCourseQuestionWidget(widget))
      .join("\n\n");

    return {
      text: [sanitizedVisibleContent, widgetText].join("\n\n"),
      appendedText: "",
    };
  }

  if (hasLearnerQuestion) {
    return {
      text: generatedText,
      appendedText: "",
    };
  }

  if (!generatedText) {
    const fallbackLesson = [
      `This milestone is about ${input.pageObjective}`,
      "A good answer should name the core idea, explain why it matters, and connect it to a small example.",
      fallbackWidget,
    ].join("\n\n");

    return {
      text: fallbackLesson,
      appendedText: fallbackLesson,
    };
  }

  const parsedRepairContent = stripInvalidRepairParagraphs(
    parsedGeneratedTurn.content.trim(),
  );
  const shouldStripTrailingPartialContent =
    input.stripTrailingPartialContent === true &&
    !PARTIAL_QUESTION_WIDGET_PATTERN.test(generatedText);
  const shouldStripDanglingTail =
    !shouldStripTrailingPartialContent &&
    !PARTIAL_QUESTION_WIDGET_PATTERN.test(generatedText) &&
    !/[.!?)]\s*$/u.test(parsedRepairContent);
  const strippedRepairContent = shouldStripTrailingPartialContent
    ? stripTrailingPartialRepairContent(parsedRepairContent)
    : shouldStripDanglingTail
      ? stripDanglingTrailingRepairContent(parsedRepairContent)
      : parsedRepairContent;
  const repairBaseText =
    strippedRepairContent ||
    (shouldStripTrailingPartialContent || shouldStripDanglingTail
      ? ""
      : parsedRepairContent) ||
    `This milestone is about ${input.pageObjective}`;
  const separator = /[.!?)]\s*$/u.test(repairBaseText) ? "\n\n" : ".\n\n";
  const fallbackQuestion = [
    separator.trimEnd(),
    `Focus on this milestone: ${input.pageObjective}`,
    fallbackWidget,
  ].join("\n\n");

  return {
    text: `${repairBaseText}${fallbackQuestion}`,
    appendedText: fallbackQuestion,
  };
}

function stripInvalidRepairParagraphs(text: string): string {
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        !isLeakedWidgetJsonParagraph(paragraph) &&
        !isLeakedTutorMetaParagraph(paragraph),
    )
    .join("\n\n")
    .trim();
}

function isLeakedWidgetJsonParagraph(paragraph: string): boolean {
  return /\\?"(?:type|id|question|choices|placeholder)\\?"\s*:/u.test(
    paragraph,
  );
}

function isLeakedTutorMetaParagraph(paragraph: string): boolean {
  return (
    /^(?:total\s+words?|word\s+count)\s*:/iu.test(paragraph) ||
    /^(?:perfect\.?\s+)?fits\s+the\s+\d+\s*[-–]\s*\d+\s+(?:word\s+)?range/iu.test(
      paragraph,
    ) ||
    /^goal\s*:/iu.test(paragraph) ||
    /^question\s*:/iu.test(paragraph) ||
    /^let'?s\s+(?:ask|use)\s+(?:a\s+)?(?:multiple-choice|free-text|question)/iu.test(
      paragraph,
    ) ||
    /^:\*\*$/u.test(paragraph) ||
    /^\*\*[,.:;]/u.test(paragraph) ||
    isUnmatchedClosingFragment(paragraph)
  );
}

function isUnmatchedClosingFragment(paragraph: string): boolean {
  const openingCount = (paragraph.match(/\(/gu) ?? []).length;
  const closingCount = (paragraph.match(/\)/gu) ?? []).length;

  return (
    closingCount > openingCount &&
    paragraph.length < 140 &&
    /^[a-z]/u.test(paragraph)
  );
}

function stripTrailingPartialRepairContent(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return stripFinalSentence(text);
  }

  return paragraphs.slice(0, -1).join("\n\n").trim() || text;
}

function stripDanglingTrailingRepairContent(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs.slice(0, -1).join("\n\n").trim();
  }

  return keepCompleteSentences(text);
}

function stripDanglingTailIfNeeded(text: string): string {
  return /[.!?)]\s*$/u.test(text) ? text : stripDanglingTrailingRepairContent(text);
}

function stripFinalSentence(text: string): string {
  const sentences =
    text.match(/[^.!?]+[.!?]+(?:\s+|$)/gu)?.map((sentence) => sentence.trim()) ??
    [];

  if (sentences.length < 2) {
    return "";
  }

  return sentences.slice(0, -1).join(" ").trim() || text;
}

function keepCompleteSentences(text: string): string {
  return (
    text.match(/[^.!?]+[.!?]+(?:\s+|$)/gu)?.map((sentence) => sentence.trim()) ??
    []
  )
    .join(" ")
    .trim();
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

  if (parseCourseQuestionWidgets(normalizedText).widgets.length > 0) {
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
