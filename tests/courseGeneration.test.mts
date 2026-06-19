import assert from "node:assert/strict";
import test from "node:test";
import {
  excerptCourseMessageForPrompt,
  ensureCourseChatTurnHasLearnerQuestion,
  isCourseChatTurnComplete,
  shouldShowCourseChatInterruptedWarning,
} from "../app/lib/courseChatTurn.ts";
import {
  parseCourseQuestionWidgetAnswer,
  parseCourseQuestionWidgets,
  serializeCourseQuestionWidget,
} from "../app/lib/courseQuestionWidget.ts";
import {
  parseCourseQuestionAttemptToolResult,
  reformatMultipleChoiceQuestionForReview,
  stripMultipleChoiceOptionsFromQuestion,
} from "../app/lib/courseQuestionAttemptParsing.ts";
import { requireCourseMilestoneMastery } from "../app/lib/courseProgress.ts";
import { normalizePartialCourseToc } from "../app/lib/courseTocStream.ts";

test("ensureCourseChatTurnHasLearnerQuestion creates first-milestone content for empty output", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.match(result.text, /Why PPO Needs an Entropy Term/u);
  assert.match(result.text, /Explain why entropy/u);
  assert.equal(parseCourseQuestionWidgets(result.text).widgets[0]?.question, "What is the main idea of this milestone in your own words?");
  assert.equal(result.appendedText, result.text);
});

test("ensureCourseChatTurnHasLearnerQuestion appends checkpoint to lesson without a question", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Entropy regularization rewards a policy for keeping action probabilities spread out.",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.match(result.text, /Entropy regularization rewards/u);
  assert.equal(parseCourseQuestionWidgets(result.text).widgets[0]?.type, "free_text");
  assert.equal(parseCourseQuestionWidgets(result.appendedText).widgets[0]?.question, "What is the main idea of this milestone in your own words?");
});

test("ensureCourseChatTurnHasLearnerQuestion preserves a complete learner question", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Entropy keeps the policy from collapsing too early.\n\nWhy does that matter for PPO?",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.equal(
    result.text,
    "Entropy keeps the policy from collapsing too early.\n\nWhy does that matter for PPO?",
  );
  assert.equal(result.appendedText, "");
});

test("ensureCourseChatTurnHasLearnerQuestion repairs dangling learner prompt", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "PPO constrains updates so the new policy stays close to the old one.\n\nIn your own",
    pageTitle: "Why PPO Uses a Special Loss Function",
    pageObjective: "Explain why PPO constrains policy changes.",
  });

  assert.match(result.text, /In your own\.\n\nFocus on this milestone/u);
  assert.equal(parseCourseQuestionWidgets(result.text).widgets[0]?.question, "What is the main idea of this milestone in your own words?");
  assert.equal(parseCourseQuestionWidgets(result.appendedText).widgets[0]?.type, "free_text");
});

test("ensureCourseChatTurnHasLearnerQuestion repairs mid-word truncation", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Advantage says whether that action was better or worse than expec",
    pageTitle: "Policy Gradient Loss Refresher",
    pageObjective: "Review how advantages shape policy updates.",
  });

  assert.match(result.text, /worse than expec\.\n\nFocus on this milestone/u);
  assert.equal(parseCourseQuestionWidgets(result.text).widgets[0]?.question, "What is the main idea of this milestone in your own words?");
});

test("isCourseChatTurnComplete accepts terminal questions and multiple choice", () => {
  assert.equal(isCourseChatTurnComplete("Why does that matter for PPO?"), true);
  assert.equal(
    isCourseChatTurnComplete(
      [
        "Entropy keeps the policy exploratory.",
        serializeCourseQuestionWidget({
          type: "free_text",
          id: "entropy-check",
          question: "Why does entropy matter for PPO exploration?",
        }),
      ].join("\n\n"),
    ),
    true,
  );
  assert.equal(
    isCourseChatTurnComplete(
      "Choose the best option.\n\nA) Increase the sampled action\nB) Decrease the sampled action",
    ),
    true,
  );
  assert.equal(isCourseChatTurnComplete("In your own"), false);
});

test("shouldShowCourseChatInterruptedWarning only flags the latest incomplete tutor turn", () => {
  assert.equal(
    shouldShowCourseChatInterruptedWarning({
      role: "assistant",
      content: "High explained variance usually me",
    }),
    true,
  );

  assert.equal(
    shouldShowCourseChatInterruptedWarning({
      role: "assistant",
      content: "High explained variance usually me",
      hasLaterStoredMessage: true,
    }),
    false,
  );

  assert.equal(
    shouldShowCourseChatInterruptedWarning({
      role: "assistant",
      content: "Why does that matter for PPO?",
    }),
    false,
  );
});

test("requireCourseMilestoneMastery only advances after high-scoring evaluation", () => {
  const proposedAdvance = {
    toolCall: "mark_milestone_done" as const,
    reason: "The learner answered correctly.",
  };

  assert.deepEqual(
    requireCourseMilestoneMastery({
      progressDecision: proposedAdvance,
      evaluationScore: 9,
    }),
    proposedAdvance,
  );
  assert.equal(
    requireCourseMilestoneMastery({
      progressDecision: proposedAdvance,
      evaluationScore: 8,
    }).toolCall,
    "continue_current_milestone",
  );
  assert.equal(
    requireCourseMilestoneMastery({
      progressDecision: proposedAdvance,
      evaluationScore: null,
    }).toolCall,
    "continue_current_milestone",
  );
});

test("excerptCourseMessageForPrompt preserves final learner question", () => {
  const finalQuestion =
    "In PPO, explained variance mainly evaluates which component?";
  const longLesson = [
    "Milestone 1: What explained variance measures in PPO",
    "In PPO, explained variance is a metric for the value function, not directly for the policy.".repeat(
      18,
    ),
    "Key pieces:",
    "- Observed returns: what happened",
    "- Value predictions: what the value function guessed",
    finalQuestion,
    "A) The policy's action choices",
    "B) The value function's return predictions",
  ].join("\n\n");

  const excerpt = excerptCourseMessageForPrompt(longLesson, 1_200);

  assert.ok(excerpt.length <= 1_200);
  assert.match(excerpt, /Milestone 1/u);
  assert.match(excerpt, /middle omitted/u);
  assert.match(excerpt, /explained variance mainly evaluates/u);
  assert.match(excerpt, /value function's return predictions/u);
});

test("normalizePartialCourseToc extracts complete streamed TOC pages", () => {
  const partialToc = normalizePartialCourseToc(
    [
      '{"title":"PPO Entropy Loss","description":"Explore entropy in PPO.","pages":[',
      '{"title":"Why PPO Needs Entropy","objective":"Explain entropy as an exploration pressure."},',
      '{"title":"Entropy Coefficient","objective":"Tune the coefficient',
    ].join(""),
  );

  assert.equal(partialToc.title, "PPO Entropy Loss");
  assert.equal(partialToc.description, "Explore entropy in PPO.");
  assert.deepEqual(partialToc.pages, [
    {
      title: "Why PPO Needs Entropy",
      objective: "Explain entropy as an exploration pressure.",
    },
  ]);
});

test("normalizePartialCourseToc handles escaped strings in streamed properties", () => {
  const partialToc = normalizePartialCourseToc(
    '{"title":"PPO \\"entropy\\" loss","description":"A \\\\ B","pages":[]}',
  );

  assert.equal(partialToc.title, 'PPO "entropy" loss');
  assert.equal(partialToc.description, "A \\ B");
});

test("parseCourseQuestionAttemptToolResult accepts snake_case correct answer fields", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What happens when advantage is negative?",
      answer: "It goes down.",
      answer_summary: "Learner said probability decreases.",
      concise_answer: "Probability decreases.",
      correct_answer: "The sampled action's probability decreases.",
      justification: "Correct.",
      score: 10,
    }),
    "fallback answer",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(
      result.correctAnswer,
      "The sampled action's probability decreases.",
    );
    assert.equal(result.conciseAnswer, "Probability decreases.");
  }
});

test("parseCourseQuestionAttemptToolResult stores the learner answer over model paraphrase", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What happens when advantage is negative?",
      answer: "Learner said the probability changes.",
      answerSummary: "Learner said probability decreases.",
      conciseAnswer: "The sampled action's probability decreases.",
      correctAnswer: "The sampled action's probability decreases.",
      justification: "Correct.",
      score: 10,
    }),
    "It goes down.",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(result.answer, "It goes down.");
  }
});

test("parseCourseQuestionAttemptToolResult reformats multiple-choice question for review", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: [
        "Choose the best meaning of a PPO ratio r = 0.5:",
        "",
        "A) The sampled action is now twice as likely under the new policy",
        "B) The sampled action is now half as likely under the new policy",
        "C) The advantage is negative",
        "D) The policy loss is zero",
      ].join("\n"),
      answer: "this is test",
      answerSummary: "Learner did not identify a valid option.",
      conciseAnswer:
        "The sampled action is now half as likely under the new policy.",
      correctAnswer:
        "The sampled action is now half as likely under the new policy.",
      justification:
        "A PPO ratio of 0.5 means the new policy probability is half of the old policy probability.",
      score: 0,
    }),
    "fallback answer",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(
      result.question,
      "What does a PPO ratio $r = 0.5$ mean?",
    );
  }
});

test("parseCourseQuestionAttemptToolResult stores selected multiple-choice answer text", () => {
  const selectedAnswer =
    "The sampled action is now half as likely under the new policy";
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: [
        "Choose the best meaning of a PPO ratio r = 0.5:",
        "",
        "A) The sampled action is now twice as likely under the new policy",
        `B) ${selectedAnswer}`,
        "C) The advantage is negative",
        "D) The policy loss is zero",
      ].join("\n"),
      answer: "The model inferred option B.",
      answerSummary: "Learner selected B.",
      conciseAnswer: selectedAnswer,
      correctAnswer: selectedAnswer,
      justification:
        "A PPO ratio of 0.5 means the new policy probability is half of the old policy probability.",
      score: 10,
    }),
    "B",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(result.answer, selectedAnswer);
  }
});

test("parseCourseQuestionAttemptToolResult reads choices from tutor message context", () => {
  const selectedAnswer =
    "The sampled action is now half as likely under the new policy";
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What does a PPO ratio r = 0.5 mean?",
      answer: "The model inferred option B.",
      answerSummary: "Learner selected B.",
      conciseAnswer: selectedAnswer,
      correctAnswer: selectedAnswer,
      justification:
        "A PPO ratio of 0.5 means the new policy probability is half of the old policy probability.",
      score: 10,
    }),
    "B",
    [
      "Choose the best meaning of a PPO ratio r = 0.5:",
      "",
      "A) The sampled action is now twice as likely under the new policy",
      `B) ${selectedAnswer}`,
      "C) The advantage is negative",
      "D) The policy loss is zero",
    ].join("\n"),
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(result.answer, selectedAnswer);
  }
});

test("parseCourseQuestionAttemptToolResult reads choices from a hidden question widget", () => {
  const selectedAnswer =
    "The sampled action is now half as likely under the new policy";
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What does a PPO ratio r = 0.5 mean?",
      answer: "The model inferred option B.",
      answerSummary: "Learner selected B.",
      conciseAnswer: selectedAnswer,
      correctAnswer: selectedAnswer,
      justification:
        "A PPO ratio of 0.5 means the new policy probability is half of the old policy probability.",
      score: 10,
    }),
    [
      "<!-- waxon:answered-question",
      "question: What does a PPO ratio r = 0.5 mean?",
      "widget_id: ratio-check",
      "-->",
      "B",
    ].join("\n"),
    serializeCourseQuestionWidget({
      type: "multiple_choice",
      id: "ratio-check",
      question: "What does a PPO ratio r = 0.5 mean?",
      choices: [
        {
          id: "A",
          text: "The sampled action is now twice as likely under the new policy",
        },
        { id: "B", text: selectedAnswer },
        { id: "C", text: "The advantage is negative" },
        { id: "D", text: "The policy loss is zero" },
      ],
    }),
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(result.answer, selectedAnswer);
  }
});

test("parseCourseQuestionWidgetAnswer reads hidden question metadata", () => {
  const parsed = parseCourseQuestionWidgetAnswer(
    [
      "<!-- waxon:answered-question",
      "question: A regression model has R-squared = 0.80. What does that mean?",
      "widget_id: r2-check",
      "-->",
      "B) The model explains about 80% of the variation in the outcome values.",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    question: "A regression model has R-squared = 0.80. What does that mean?",
    widgetId: "r2-check",
    answer:
      "B) The model explains about 80% of the variation in the outcome values.",
  });
});

test("parseCourseQuestionAttemptToolResult preserves inline markdown from tutor question", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question:
        "Which probability distribution has higher entropy: a certain two-outcome distribution [1, 0] or an equally likely two-outcome distribution [0.5, 0.5]?",
      answer: "The model inferred option B.",
      answerSummary: "Learner selected B.",
      conciseAnswer: "The equally likely distribution has higher entropy.",
      correctAnswer: "The equally likely distribution has higher entropy.",
      justification:
        "[0.5, 0.5] has higher entropy because the outcome is uncertain.",
      score: 10,
    }),
    "B",
    "Which distribution has higher entropy, A) `[1, 0]` or B) `[0.5, 0.5]`?",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(
      result.question,
      "Which probability distribution has higher entropy: a certain two-outcome distribution `[1, 0]` or an equally likely two-outcome distribution `[0.5, 0.5]`?",
    );
  }
});

test("parseCourseQuestionAttemptToolResult preserves inline math from tutor question", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What does r = 0.5 mean for the sampled action?",
      answer: "It is half as likely.",
      answerSummary: "Learner said half as likely.",
      conciseAnswer: "The sampled action is half as likely.",
      correctAnswer: "The sampled action is half as likely.",
      justification: "Correct.",
      score: 10,
    }),
    "It is half as likely.",
    "What does $r = 0.5$ mean for the sampled action?",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(
      result.question,
      "What does $r = 0.5$ mean for the sampled action?",
    );
  }
});

test("parseCourseQuestionAttemptToolResult strips multiple-choice label from answer text", () => {
  const selectedAnswer =
    "The sampled action is now half as likely under the new policy";
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: [
        "Choose the best meaning of a PPO ratio r = 0.5:",
        "",
        "A) The sampled action is now twice as likely under the new policy",
        `B) ${selectedAnswer}`,
      ].join("\n"),
      answer: "B) The sampled action is now half as likely under the new policy",
      answerSummary: "Learner selected B.",
      conciseAnswer: selectedAnswer,
      correctAnswer: selectedAnswer,
      justification: "Correct.",
      score: 10,
    }),
    "B) The sampled action is now half as likely under the new policy",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(result.answer, selectedAnswer);
  }
});

test("parseCourseQuestionAttemptToolResult preserves full justification text", () => {
  const justification = [
    "The selected answer is incorrect.",
    "Having exactly two actions with easy value comparisons is a setting where value-based methods can work naturally.",
    "Policy-based methods are especially useful when actions are continuous or when stochastic policies must be optimized directly.",
    "That distinction matters because policy gradients optimize the action distribution itself rather than first estimating action values.",
  ].join(" ");
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question:
        "What kind of reinforcement learning situation is especially well-suited for policy-based methods rather than value-based methods?",
      answer: "Two actions with easy value comparisons.",
      answerSummary: "Learner chose two discrete actions.",
      conciseAnswer:
        "Continuous actions or directly optimized stochastic policies.",
      correctAnswer:
        "Continuous actions or directly optimized stochastic policies.",
      justification,
      score: 2,
    }),
    "fallback answer",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.ok(justification.length > 240);
    assert.equal(result.justification, justification);
    assert.match(result.justification, /action distribution itself/u);
  }
});

test("multiple-choice question cleanup keeps non-choice question text", () => {
  assert.equal(
    stripMultipleChoiceOptionsFromQuestion(
      "Why can ratio clipping stabilize PPO updates?",
    ),
    "Why can ratio clipping stabilize PPO updates?",
  );
  assert.equal(
    stripMultipleChoiceOptionsFromQuestion(
      "Choose the best option.\n\n- **A)** Larger updates\n- **B)** Smaller bounded updates",
    ),
    "Choose the best option.",
  );
  assert.equal(
    reformatMultipleChoiceQuestionForReview(
      "Choose the best meaning of r = 0.5:\n\nA) Twice as likely\nB) Half as likely",
    ),
    "What does $r = 0.5$ mean?",
  );
});

test("parseCourseQuestionAttemptToolResult falls back to useful correct feedback", () => {
  const result = parseCourseQuestionAttemptToolResult(
    JSON.stringify({
      toolCall: "record_course_question_attempt",
      question: "What happens when advantage is negative?",
      answer: "It goes down.",
      answerSummary: "Learner said probability decreases.",
      justification:
        "Correct. A negative advantage pushes the sampled action's probability downward.",
      score: 10,
    }),
    "fallback answer",
  );

  assert.equal(result.toolCall, "record_course_question_attempt");

  if (result.toolCall === "record_course_question_attempt") {
    assert.equal(
      result.correctAnswer,
      "A negative advantage pushes the sampled action's probability downward.",
    );
  }
});
