import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowLearnQuestionWidgets } from "../app/lib/learnQuestionWidgetVisibility.ts";

const assistantWithWidget = {
  role: "assistant" as const,
  content: "Lesson",
};

test("shouldShowLearnQuestionWidgets shows only unanswered active widgets", () => {
  assert.equal(
    shouldShowLearnQuestionWidgets({
      messages: [assistantWithWidget],
      message: assistantWithWidget,
      messageIndex: 0,
      widgetCount: 1,
      answeredWidgetCount: 0,
      hasEvaluationSnippet: false,
    }),
    true,
  );
});

test("shouldShowLearnQuestionWidgets keeps answered widgets visible during evaluation", () => {
  const pendingEvaluation = {
    role: "assistant" as const,
    content: "",
    pendingEvaluation: true,
  };

  assert.equal(
    shouldShowLearnQuestionWidgets({
      messages: [
        assistantWithWidget,
        {
          role: "user",
          content: "My answer",
        },
        pendingEvaluation,
      ],
      message: assistantWithWidget,
      messageIndex: 0,
      widgetCount: 1,
      answeredWidgetCount: 1,
      hasEvaluationSnippet: false,
    }),
    true,
  );
});

test("shouldShowLearnQuestionWidgets hides widgets replaced by an evaluation", () => {
  assert.equal(
    shouldShowLearnQuestionWidgets({
      messages: [
        assistantWithWidget,
        {
          role: "assistant",
          content: "Score 9/10\n\nGood.",
          evaluation: {
            score: 9,
          },
        },
      ],
      message: assistantWithWidget,
      messageIndex: 0,
      widgetCount: 1,
      answeredWidgetCount: 0,
      hasEvaluationSnippet: false,
    }),
    false,
  );
});
