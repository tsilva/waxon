export type LearnQuestionWidgetVisibilityMessage = {
  role: "assistant" | "user";
  content: string;
  pendingEvaluation?: boolean;
  evaluation?: unknown;
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
    return !input.messages
      .slice(input.messageIndex + 1)
      .some((laterMessage) => laterMessage.pendingEvaluation || laterMessage.evaluation);
  }

  return !input.messages.slice(input.messageIndex + 1).some((laterMessage) => {
    return (
      laterMessage.role === "user" ||
      laterMessage.pendingEvaluation ||
      laterMessage.evaluation
    );
  });
}
