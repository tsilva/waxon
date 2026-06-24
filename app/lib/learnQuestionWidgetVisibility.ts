import { isQuestionEvaluationSnippet } from "./courseEvaluationSnippet.ts";

export type LearnQuestionWidgetVisibilityMessage = {
  role: "assistant" | "user";
  content: string;
  pendingEvaluation?: boolean;
};

export function shouldShowLearnQuestionWidgets(input: {
  messages: LearnQuestionWidgetVisibilityMessage[];
  message: LearnQuestionWidgetVisibilityMessage;
  messageIndex: number;
  widgetCount: number;
  answeredWidgetCount: number;
  hasEvaluationSnippet: boolean;
}) {
  if (
    input.message.role !== "assistant" ||
    input.widgetCount === 0 ||
    input.hasEvaluationSnippet
  ) {
    return false;
  }

  if (input.answeredWidgetCount > 0) {
    return false;
  }

  return !input.messages.slice(input.messageIndex + 1).some((laterMessage) => {
    return (
      laterMessage.role === "user" ||
      laterMessage.pendingEvaluation ||
      isQuestionEvaluationSnippet(laterMessage.content)
    );
  });
}
