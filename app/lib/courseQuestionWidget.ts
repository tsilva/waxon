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

export const COURSE_QUESTION_WIDGET_TOOL_NAME = "render_question_widget";

export type CourseQuestionWidgetToolCall = {
  id: string;
  type: "function";
  function: {
    name: typeof COURSE_QUESTION_WIDGET_TOOL_NAME;
    arguments: CourseQuestionWidget;
  };
};

export type CourseQuestionWidgetAnswerDetails = {
  question: string | null;
  widgetId: string | null;
  answer: string;
};

const MAX_WIDGET_TEXT_CHARS = 1_200;
const MAX_WIDGET_ID_CHARS = 80;
const MAX_CHOICE_TEXT_CHARS = 500;

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

export function normalizeCourseQuestionWidget(
  value: unknown,
): CourseQuestionWidget | null {
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

function normalizeToolCallArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeCourseQuestionWidgetToolCalls(
  value: unknown,
): CourseQuestionWidgetToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }

    const record = candidate as Record<string, unknown>;
    const rawFunction = record.function;

    if (!rawFunction || typeof rawFunction !== "object" || Array.isArray(rawFunction)) {
      return [];
    }

    const functionRecord = rawFunction as Record<string, unknown>;

    if (functionRecord.name !== COURSE_QUESTION_WIDGET_TOOL_NAME) {
      return [];
    }

    const widget = normalizeCourseQuestionWidget(
      normalizeToolCallArguments(functionRecord.arguments),
    );

    if (!widget) {
      return [];
    }

    const rawId = normalizeText(record.id, MAX_WIDGET_ID_CHARS);

    return [
      {
        id: rawId || `widget-call-${index + 1}`,
        type: "function" as const,
        function: {
          name: COURSE_QUESTION_WIDGET_TOOL_NAME,
          arguments: widget,
        },
      },
    ];
  });
}

export function courseQuestionWidgetToolCallFromWidget(
  widget: CourseQuestionWidget,
  id = `widget-call-${widget.id}`,
): CourseQuestionWidgetToolCall {
  return {
    id,
    type: "function",
    function: {
      name: COURSE_QUESTION_WIDGET_TOOL_NAME,
      arguments: widget,
    },
  };
}

export function courseQuestionWidgetsFromToolCalls(
  toolCalls: unknown,
): CourseQuestionWidget[] {
  return normalizeCourseQuestionWidgetToolCalls(toolCalls).map(
    (toolCall) => toolCall.function.arguments,
  );
}

export function formatCourseQuestionWidgetForPrompt(
  widget: CourseQuestionWidget,
): string {
  const lines = [`Question widget: ${widget.question}`];

  if (widget.type === "multiple_choice") {
    lines.push(
      "Choices:",
      ...widget.choices.map((choice) => `${choice.id}) ${choice.text}`),
    );
  }

  return lines.join("\n");
}

export function formatCourseQuestionWidgetsForPrompt(
  widgets: CourseQuestionWidget[],
): string {
  return widgets.map(formatCourseQuestionWidgetForPrompt).join("\n\n");
}
