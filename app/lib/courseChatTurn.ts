import type {
  CourseQuestionWidget,
  CourseToolCall,
} from "./courseQuestionWidget.ts";

const FALLBACK_LEARNER_QUESTION = "What is the main idea in your own words?";
const FALLBACK_VISIBLE_TEACHING_TEXT =
  "A good answer should name the core idea, explain why it matters, and connect it to a small example.";
const MISSING_VISIBLE_TUTOR_TEXT_MESSAGE =
  "Course chat generation did not emit visible tutor text before the question widget.";

export class CourseTutorTextMissingError extends Error {
  constructor() {
    super(MISSING_VISIBLE_TUTOR_TEXT_MESSAGE);
    this.name = "CourseTutorTextMissingError";
  }
}

export function ensureCourseChatTurnHasLearnerQuestion(input: {
  text: string;
  pageTitle: string;
  pageObjective: string;
  widgets?: CourseQuestionWidget[];
  stripTrailingPartialContent?: boolean;
  requireVisibleTeachingTextWithWidgets?: boolean;
}): {
  text: string;
  appendedText: string;
  widgets: CourseQuestionWidget[];
} {
  const generatedText = input.text.trim();
  const inputWidgets = (input.widgets ?? []).map(sanitizeLearnerFacingCourseWidget);
  const hasLearnerQuestion = isCourseChatTurnComplete(generatedText, inputWidgets);
  const fallbackLearnerQuestion = fallbackQuestionFromPageObjective(
    input.pageObjective,
  );
  const fallbackWidget: CourseQuestionWidget = {
    type: "free_text",
    id: "fallback-understanding-check",
    question: fallbackLearnerQuestion,
    placeholder: "Explain the idea in your own words...",
  };

  if (inputWidgets.length > 0) {
    const cleanedVisibleContent = stripInvalidRepairParagraphs(
      generatedText,
    );
    const visibleContent = stripDanglingTailIfNeeded(cleanedVisibleContent);

    if (input.requireVisibleTeachingTextWithWidgets && !visibleContent.trim()) {
      throw new CourseTutorTextMissingError();
    }

    const sanitizedVisibleContent = sanitizeLearnerFacingCourseText(
      visibleContent || FALLBACK_VISIBLE_TEACHING_TEXT,
    );

    return {
      text: sanitizedVisibleContent,
      appendedText: "",
      widgets: inputWidgets,
    };
  }

  if (hasLearnerQuestion && !input.requireVisibleTeachingTextWithWidgets) {
    return {
      text: sanitizeLearnerFacingCourseText(generatedText),
      appendedText: "",
      widgets: [],
    };
  }

  if (hasLearnerQuestion && input.requireVisibleTeachingTextWithWidgets) {
    const teachingText =
      sanitizeLearnerFacingCourseText(stripTrailingQuestion(generatedText)) ||
      FALLBACK_VISIBLE_TEACHING_TEXT;

    return {
      text: teachingText,
      appendedText: "",
      widgets: [fallbackWidget],
    };
  }

  if (!generatedText) {
    const fallbackLesson = [
      "Let's make the next check about the main idea from this section.",
      "A good answer should name the core idea, explain why it matters, and connect it to a small example.",
    ].join("\n\n");

    return {
      text: fallbackLesson,
      appendedText: fallbackLesson,
      widgets: [fallbackWidget],
    };
  }

  const parsedRepairContent = stripInvalidRepairParagraphs(
    generatedText,
  );
  const rawRepairParagraphCount = generatedText
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
  const cleanedRepairParagraphCount = parsedRepairContent
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
  const removedInvalidRepairParagraph =
    cleanedRepairParagraphCount < rawRepairParagraphCount;
  const shouldStripTrailingPartialContent =
    input.stripTrailingPartialContent === true &&
    !removedInvalidRepairParagraph;
  const shouldStripDanglingTail =
    !shouldStripTrailingPartialContent &&
    !/[.!?)]\s*$/u.test(parsedRepairContent);
  const strippedRepairContent = shouldStripTrailingPartialContent
    ? stripTrailingPartialRepairContent(parsedRepairContent)
    : shouldStripDanglingTail
      ? stripDanglingTrailingRepairContent(parsedRepairContent)
      : parsedRepairContent;
  const repairBaseText =
    sanitizeLearnerFacingCourseText(strippedRepairContent) ||
    (shouldStripTrailingPartialContent || shouldStripDanglingTail
      ? ""
      : sanitizeLearnerFacingCourseText(parsedRepairContent)) ||
    FALLBACK_VISIBLE_TEACHING_TEXT;

  return {
    text: repairBaseText,
    appendedText: "",
    widgets: [fallbackWidget],
  };
}

export function sanitizeLearnerFacingCourseText(text: string): string {
  return stripLeakedFocusPromptParagraphs(text)
    .replace(
      /\bwhat is the main idea of this milestone in your own words\?/giu,
      (match) => preserveLeadingCase(match, FALLBACK_LEARNER_QUESTION),
    )
    .replace(/\bthis milestone is about\b/giu, (match) =>
      preserveLeadingCase(match, "this section is about"),
    )
    .replace(/\bmilestone objective\b/giu, (match) =>
      preserveLeadingCase(match, "learning goal"),
    )
    .replace(/\bcurrent milestone\b/giu, (match) =>
      preserveLeadingCase(match, "current topic"),
    )
    .replace(/\bnext milestone\b/giu, (match) =>
      preserveLeadingCase(match, "next topic"),
    )
    .replace(/\bsame milestone\b/giu, (match) =>
      preserveLeadingCase(match, "same topic"),
    )
    .replace(/\bthis milestone\b/giu, (match) =>
      preserveLeadingCase(match, "this topic"),
    )
    .replace(/\bthe milestone\b/giu, (match) =>
      preserveLeadingCase(match, "the topic"),
    );
}

function fallbackQuestionFromPageObjective(pageObjective: string): string {
  const objective = sanitizeLearnerFacingCourseText(pageObjective)
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "");

  if (!objective) {
    return FALLBACK_LEARNER_QUESTION;
  }

  const explainableObjective = objective
    .replace(/^(?:understand|learn|review)\s+to\s+/iu, "explain how to ")
    .replace(/^master\s+the\s+use\s+of\s+/iu, "explain how to use ")
    .replace(/^(?:understand|learn|review)\s+/iu, "explain ");
  const questionStem = /^[A-Z]/u.test(explainableObjective)
    ? `${explainableObjective.slice(0, 1).toLowerCase()}${explainableObjective.slice(1)}`
    : explainableObjective;

  return `In your own words, ${questionStem}?`;
}

export function sanitizeLearnerFacingCourseWidget(
  widget: CourseQuestionWidget,
): CourseQuestionWidget {
  if (widget.type === "multiple_choice") {
    return {
      ...widget,
      id: sanitizeLearnerFacingCourseWidgetId(widget.id),
      question: sanitizeLearnerFacingCourseText(widget.question),
      choices: widget.choices.map((choice) => ({
        ...choice,
        text: sanitizeLearnerFacingCourseText(choice.text),
      })),
    };
  }

  return {
    ...widget,
    id: sanitizeLearnerFacingCourseWidgetId(widget.id),
    question: sanitizeLearnerFacingCourseText(widget.question),
    placeholder: widget.placeholder
      ? sanitizeLearnerFacingCourseText(widget.placeholder)
      : widget.placeholder,
  };
}

export function sanitizeLearnerFacingCourseWidgetToolCalls(
  toolCalls: CourseToolCall[],
): CourseToolCall[] {
  return toolCalls.map((toolCall) => {
    if (toolCall.function.name !== "render_question_widget") {
      return toolCall;
    }

    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: sanitizeLearnerFacingCourseWidget(toolCall.function.arguments),
      },
    };
  });
}

function sanitizeLearnerFacingCourseWidgetId(id: string): string {
  return id === "fallback-milestone-check"
    ? "fallback-understanding-check"
    : id;
}

function preserveLeadingCase(source: string, replacement: string): string {
  return /^[A-Z]/u.test(source)
    ? `${replacement.slice(0, 1).toUpperCase()}${replacement.slice(1)}`
    : replacement;
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
    isLeakedFocusPromptParagraph(paragraph) ||
    /^let'?s\s+(?:ask|use)\s+(?:a\s+)?(?:multiple-choice|free-text|question)/iu.test(
      paragraph,
    ) ||
    /^:\*\*$/u.test(paragraph) ||
    /^\*\*[,.:;]/u.test(paragraph) ||
    isUnmatchedClosingFragment(paragraph)
  );
}

function stripLeakedFocusPromptParagraphs(text: string): string {
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => !isLeakedFocusPromptParagraph(paragraph))
    .join("\n\n")
    .trim();
}

function isLeakedFocusPromptParagraph(paragraph: string): boolean {
  return /^focus\s+on\s+this\s+(?:idea|milestone)\s*:/iu.test(paragraph);
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

function stripTrailingQuestion(text: string): string {
  return text.replace(/(?:^|\n|\s)[^.!?\n][^?\n]*\?\s*$/u, "").trim();
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

export function isCourseChatTurnComplete(
  text: string,
  widgets: CourseQuestionWidget[] = [],
): boolean {
  const normalizedText = text.trim();

  if (!normalizedText) {
    return false;
  }

  if (/that completes the course\./iu.test(normalizedText)) {
    return true;
  }

  if (widgets.length > 0) {
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
