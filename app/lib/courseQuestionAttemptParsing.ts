import {
  parseCourseQuestionWidgets,
  stripAnsweredQuestionMetadata,
} from "./courseQuestionWidget.ts";

export type CourseQuestionAttemptToolResult =
  | {
      toolCall: "record_course_question_attempt";
      question: string;
      answer: string;
      answerSummary: string;
      conciseAnswer: string;
      correctAnswer: string;
      justification: string;
      score: number;
    }
  | {
      toolCall: "skip_course_question_attempt";
      reason: string;
    };

function extractJsonObject(source: string): unknown | null {
  const trimmed = source.trim();
  const json = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function normalizeIntakeText(value: unknown, maxLength?: number): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  return maxLength === undefined ? normalized : normalized.slice(0, maxLength);
}

function normalizeMultilineText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\n{3,}/g, "\n\n").slice(0, maxLength)
    : "";
}

const CHOICE_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:[A-H]|\d{1,2})[\).:-](?:\*\*)?\s+\S/iu;
const CHOICE_LINE_CAPTURE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:\*\*)?([A-H]|\d{1,2})[\).:-](?:\*\*)?\s+(.+)$/iu;
const CHOICE_ANSWER_PREFIX_PATTERN =
  /^(?:option|choice|answer)?\s*([A-H]|\d{1,2})\s*[\).:-]\s+(.+)$/iu;
const CHOICE_ANSWER_ONLY_PATTERN =
  /^(?:option|choice|answer)?\s*([A-H]|\d{1,2})\s*[\).:-]?$/iu;
const CHOICE_ANSWER_SENTENCE_PATTERN =
  /^(?:i\s+(?:choose|pick|picked|select|selected|would\s+choose)|choose|pick|picked|select|selected)\s+(?:option|choice|answer)?\s*([A-H]|\d{1,2})\b/iu;

export function stripMultipleChoiceOptionsFromQuestion(question: string): string {
  const lines = question.replace(/\r\n?/g, "\n").split("\n");
  const firstChoiceLineIndex = lines.findIndex((line) =>
    CHOICE_LINE_PATTERN.test(line),
  );

  if (firstChoiceLineIndex === -1) {
    return question.trim();
  }

  return lines.slice(0, firstChoiceLineIndex).join("\n").trim();
}

function normalizeChoiceKey(value: string): string {
  return value.trim().toUpperCase();
}

function readMultipleChoiceOptions(question: string): Map<string, string> {
  const choices = new Map<string, string>();

  for (const widget of parseCourseQuestionWidgets(question).widgets) {
    if (widget.type !== "multiple_choice") {
      continue;
    }

    for (const choice of widget.choices) {
      choices.set(normalizeChoiceKey(choice.id), normalizeIntakeText(choice.text));
    }
  }

  for (const line of question.replace(/\r\n?/g, "\n").split("\n")) {
    const match = CHOICE_LINE_CAPTURE_PATTERN.exec(line);

    if (match?.[1] && match[2]) {
      choices.set(normalizeChoiceKey(match[1]), normalizeIntakeText(match[2]));
    }
  }

  return choices;
}

function normalizeSubmittedAnswer(input: {
  question: string;
  choiceSource?: string;
  recordAnswer: unknown;
  fallbackAnswer: string;
}): string {
  const answer =
    stripAnsweredQuestionMetadata(
      normalizeMultilineText(input.fallbackAnswer, 4_000),
    ) ||
    normalizeMultilineText(input.recordAnswer, 4_000);
  const choices = readMultipleChoiceOptions(
    [input.question, input.choiceSource ?? ""].filter(Boolean).join("\n"),
  );

  if (!answer || choices.size === 0) {
    return answer;
  }

  const answerText = answer.trim().replace(/\s+/g, " ");
  const prefixedAnswer = CHOICE_ANSWER_PREFIX_PATTERN.exec(answerText);

  if (prefixedAnswer?.[1]) {
    return (
      choices.get(normalizeChoiceKey(prefixedAnswer[1])) ??
      normalizeIntakeText(prefixedAnswer[2])
    );
  }

  const answerOnly = CHOICE_ANSWER_ONLY_PATTERN.exec(answerText);

  if (answerOnly?.[1]) {
    return choices.get(normalizeChoiceKey(answerOnly[1])) ?? answer;
  }

  const sentenceAnswer = CHOICE_ANSWER_SENTENCE_PATTERN.exec(answerText);

  if (sentenceAnswer?.[1]) {
    return choices.get(normalizeChoiceKey(sentenceAnswer[1])) ?? answer;
  }

  return answer;
}

function formatInlineMathTarget(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");

  if (/^\$.*\$$/u.test(normalized) || /`/.test(normalized)) {
    return normalized;
  }

  const equationPattern = /\b[A-Za-z][A-Za-z0-9_]*\s*[=<>]\s*[-+]?\d+(?:\.\d+)?\b/gu;

  if (equationPattern.test(normalized)) {
    return normalized.replace(equationPattern, (match) => `$${match}$`);
  }

  return /(?:^|\s)[a-zA-Z]\s*[+\-*/^]/u.test(normalized)
    ? `$${normalized}$`
    : normalized;
}

function readInlineFormattedSpans(source: string): Array<{
  formatted: string;
  plain: string;
}> {
  const spans: Array<{ formatted: string; plain: string }> = [];
  const patterns = [
    /`([^`\n]+)`/gu,
    /\$([^$\n]+)\$/gu,
    /\\\(([^]+?)\\\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const formatted = match[0];
      const plain = match[1]?.trim();

      if (!formatted || !plain) {
        continue;
      }

      spans.push({ formatted, plain });
    }
  }

  return spans;
}

function hasFormattingBoundary(value: string, startIndex: number, length: number) {
  const before = value[startIndex - 1];
  const after = value[startIndex + length];

  return before === "`" || before === "$" || after === "`" || after === "$";
}

function applyInlineFormattingFromSource(question: string, source: string): string {
  if (!question || !source) {
    return question;
  }

  let formattedQuestion = question;

  for (const span of readInlineFormattedSpans(source)) {
    if (
      span.formatted === span.plain ||
      formattedQuestion.includes(span.formatted)
    ) {
      continue;
    }

    let searchIndex = 0;

    while (searchIndex < formattedQuestion.length) {
      const matchIndex = formattedQuestion.indexOf(span.plain, searchIndex);

      if (matchIndex === -1) {
        break;
      }

      if (!hasFormattingBoundary(formattedQuestion, matchIndex, span.plain.length)) {
        formattedQuestion =
          `${formattedQuestion.slice(0, matchIndex)}${span.formatted}` +
          formattedQuestion.slice(matchIndex + span.plain.length);
        searchIndex = matchIndex + span.formatted.length;
        continue;
      }

      searchIndex = matchIndex + span.plain.length;
    }
  }

  return formattedQuestion;
}

export function reformatMultipleChoiceQuestionForReview(question: string): string {
  const stem = stripMultipleChoiceOptionsFromQuestion(question)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*[:.]\s*$/u, "");

  const meaningMatch = stem.match(
    /^choose\s+(?:the\s+)?(?:best|correct|most\s+accurate)\s+(?:meaning|interpretation)\s+of\s+(.+)$/iu,
  );

  if (meaningMatch?.[1]) {
    return `What does ${formatInlineMathTarget(meaningMatch[1])} mean?`;
  }

  const answerMatch = stem.match(
    /^choose\s+(?:the\s+)?(?:best|correct|most\s+accurate)\s+(?:answer|option|choice)\s*(?:to|for)?\s*(.+)$/iu,
  );

  if (answerMatch?.[1]) {
    const remainder = answerMatch[1].trim().replace(/\s*[:.]\s*$/u, "");

    if (remainder && !/^(?:the\s+)?(?:question|prompt)$/iu.test(remainder)) {
      return /\?$/u.test(remainder) ? remainder : `${remainder}?`;
    }
  }

  return stem;
}

function normalizeRecordText(
  record: Record<string, unknown>,
  keys: string[],
  maxLength?: number,
): string {
  for (const key of keys) {
    const normalized = normalizeIntakeText(record[key], maxLength);

    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function parseScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

function correctAnswerFromJustification(justification: string): string {
  const normalized = justification.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/^(?:correct|right|yes)[.!]?\s+/iu, "")
    .replace(/^that's\s+(?:correct|right)[.!]?\s+/iu, "")
    .trim();
}

export function parseCourseQuestionAttemptToolResult(
  source: string,
  fallbackAnswer: string,
  choiceSource = "",
): CourseQuestionAttemptToolResult {
  const value = extractJsonObject(source);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "Question attempt tool returned no JSON object.",
    };
  }

  const record = value as Record<string, unknown>;
  const toolCall = normalizeIntakeText(record.toolCall, 80);

  if (toolCall !== "record_course_question_attempt") {
    return {
      toolCall: "skip_course_question_attempt",
      reason:
        normalizeIntakeText(record.reason, 500) ||
        "No learner-facing question was answered.",
    };
  }

  const rawQuestion = normalizeMultilineText(record.question, 1_200);
  const question = normalizeMultilineText(
    reformatMultipleChoiceQuestionForReview(
      applyInlineFormattingFromSource(rawQuestion, choiceSource),
    ),
    1_200,
  );
  const answer = normalizeSubmittedAnswer({
    question: rawQuestion,
    choiceSource,
    recordAnswer: record.answer,
    fallbackAnswer,
  });
  const score = parseScore(record.score);

  if (!question || !answer || score === null) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "Question attempt tool returned an incomplete record.",
    };
  }

  const justification =
    normalizeRecordText(record, ["justification", "feedback"]) ||
    "Recorded from course chat.";
  const explicitConciseAnswer = normalizeRecordText(
    record,
    ["conciseAnswer", "concise_answer"],
    400,
  );
  const explicitCorrectAnswer = normalizeRecordText(
    record,
    [
      "correctAnswer",
      "correct_answer",
      "expectedAnswer",
      "expected_answer",
      "idealAnswer",
      "ideal_answer",
      "referenceAnswer",
      "reference_answer",
    ],
    400,
  );
  const inferredCorrectAnswer =
    explicitCorrectAnswer ||
    explicitConciseAnswer ||
    correctAnswerFromJustification(justification) ||
    "See course explanation.";

  return {
    toolCall,
    question,
    answer,
    answerSummary:
      normalizeIntakeText(record.answerSummary ?? record.answer_summary, 240) ||
      answer.slice(0, 240),
    conciseAnswer:
      explicitConciseAnswer || explicitCorrectAnswer || inferredCorrectAnswer,
    correctAnswer: inferredCorrectAnswer,
    justification,
    score,
  };
}
