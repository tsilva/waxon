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

function normalizeIntakeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function normalizeMultilineText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\n{3,}/g, "\n\n").slice(0, maxLength)
    : "";
}

const CHOICE_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:[A-H]|\d{1,2})[\).:-](?:\*\*)?\s+\S/iu;

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
  maxLength: number,
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

  const question = normalizeMultilineText(
    reformatMultipleChoiceQuestionForReview(
      normalizeMultilineText(record.question, 1_200),
    ),
    1_200,
  );
  const answer =
    normalizeMultilineText(record.answer, 4_000) ||
    normalizeMultilineText(fallbackAnswer, 4_000);
  const score = parseScore(record.score);

  if (!question || !answer || score === null) {
    return {
      toolCall: "skip_course_question_attempt",
      reason: "Question attempt tool returned an incomplete record.",
    };
  }

  const justification =
    normalizeRecordText(record, ["justification", "feedback"], 240) ||
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
