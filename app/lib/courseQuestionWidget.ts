export type CourseQuestionWidgetChoice = {
  id: string;
  text: string;
};

export type CourseQuestionWidget =
  | {
      type: "free_text";
      id: string;
      question: string;
      placeholder?: string;
    }
  | {
      type: "multiple_choice";
      id: string;
      question: string;
      choices: CourseQuestionWidgetChoice[];
    };

const QUESTION_WIDGET_COMMENT_PATTERN =
  /<!--\s*waxon:question-widget\s+([\s\S]*?)\s*-->/gu;
const TRAILING_PARTIAL_QUESTION_WIDGET_COMMENT_PATTERN =
  /\s*<!--\s*waxon:question-widget\b[\s\S]*$/u;
const ANSWERED_QUESTION_COMMENT_PATTERN =
  /<!--\s*waxon:answered-question[\s\S]*?-->\s*/gu;
const ANSWERED_QUESTION_COMMENT_CAPTURE_PATTERN =
  /<!--\s*waxon:answered-question([\s\S]*?)-->\s*/u;
const MAX_WIDGET_TEXT_CHARS = 1_200;
const MAX_WIDGET_ID_CHARS = 80;
const MAX_CHOICE_TEXT_CHARS = 500;

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function normalizeQuestionWidget(value: unknown): CourseQuestionWidget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const type = normalizeText(record.type, 40);
  const question = normalizeText(record.question, MAX_WIDGET_TEXT_CHARS);
  const id =
    normalizeText(record.id, MAX_WIDGET_ID_CHARS) ||
    `question-${question.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48)}`;

  if (!question) {
    return null;
  }

  if (type === "multiple_choice") {
    const choices = Array.isArray(record.choices)
      ? record.choices.flatMap((choice) => {
          if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
            return [];
          }

          const choiceRecord = choice as Record<string, unknown>;
          const choiceId = normalizeText(choiceRecord.id, 8).toUpperCase();
          const text = normalizeText(choiceRecord.text, MAX_CHOICE_TEXT_CHARS);

          return choiceId && text ? [{ id: choiceId, text }] : [];
        })
      : [];

    if (choices.length < 2) {
      return null;
    }

    return {
      type: "multiple_choice",
      id,
      question,
      choices: choices.slice(0, 6),
    };
  }

  return {
    type: "free_text",
    id,
    question,
    placeholder:
      normalizeText(record.placeholder, 160) || "Type your answer here...",
  };
}

function parseEncodedWidget(source: string): CourseQuestionWidget | null {
  const encoded = source.trim();

  if (!encoded) {
    return null;
  }

  try {
    return normalizeQuestionWidget(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    try {
      return normalizeQuestionWidget(JSON.parse(encoded));
    } catch {
      return null;
    }
  }
}

export function serializeCourseQuestionWidget(
  widget: CourseQuestionWidget,
): string {
  return `<!-- waxon:question-widget ${encodeURIComponent(JSON.stringify(widget))} -->`;
}

export function parseCourseQuestionWidgets(content: string): {
  content: string;
  widgets: CourseQuestionWidget[];
} {
  const widgets: CourseQuestionWidget[] = [];
  const strippedContent = content
    .replace(
      QUESTION_WIDGET_COMMENT_PATTERN,
      (_comment, encodedWidget: string) => {
        const widget = parseEncodedWidget(encodedWidget);

        if (widget) {
          widgets.push(widget);
        }

        return "";
      },
    )
    .replace(TRAILING_PARTIAL_QUESTION_WIDGET_COMMENT_PATTERN, "");

  return {
    content: strippedContent.trim(),
    widgets,
  };
}

export function stripAnsweredQuestionMetadata(content: string): string {
  return content.replace(ANSWERED_QUESTION_COMMENT_PATTERN, "").trim();
}

export function parseCourseQuestionWidgetAnswer(content: string): {
  question: string | null;
  widgetId: string | null;
  answer: string;
} | null {
  const match = content.match(ANSWERED_QUESTION_COMMENT_CAPTURE_PATTERN);

  if (!match) {
    return null;
  }

  const metadata = match[1] ?? "";
  const answer = stripAnsweredQuestionMetadata(content);
  let question: string | null = null;
  let widgetId: string | null = null;

  for (const line of metadata.split(/\n/u)) {
    const [rawKey, ...rawValueParts] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim();

    if (key === "question" && value) {
      question = normalizeText(value, MAX_WIDGET_TEXT_CHARS);
    }

    if (key === "widget_id" && value) {
      widgetId = normalizeText(value, MAX_WIDGET_ID_CHARS);
    }
  }

  return {
    question,
    widgetId,
    answer,
  };
}

function sanitizeCommentText(value: string): string {
  return value.replace(/--/gu, "-").trim();
}

export function serializeCourseQuestionWidgetAnswer(input: {
  widget: CourseQuestionWidget;
  answer: string;
}): string {
  const question = sanitizeCommentText(input.widget.question);
  const answer = input.answer.trim();

  if (!question) {
    return answer;
  }

  return [
    "<!-- waxon:answered-question",
    `question: ${question}`,
    `widget_id: ${sanitizeCommentText(input.widget.id)}`,
    "-->",
    answer,
  ].join("\n");
}
