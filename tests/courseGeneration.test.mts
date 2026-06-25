import assert from "node:assert/strict";
import test from "node:test";
import {
  excerptCourseMessageForPrompt,
  ensureCourseChatTurnHasLearnerQuestion,
  isCourseChatTurnComplete,
  shouldShowCourseChatInterruptedWarning,
} from "../app/lib/courseChatTurn.ts";
import {
  generateCourseAnswerDecision,
  generateCourseToc,
  streamCourseAnswerContinuation,
  streamCourseChatTurn,
} from "../app/lib/courseGeneration.ts";
import {
  courseQuestionWidgetToolCallFromWidget,
  formatCourseQuestionWidgetForPrompt,
} from "../app/lib/courseQuestionWidget.ts";
import {
  parseCourseAnswerDecisionToolResult,
  parseCourseQuestionAttemptToolResult,
  reformatMultipleChoiceQuestionForReview,
  stripMultipleChoiceOptionsFromQuestion,
} from "../app/lib/courseQuestionAttemptParsing.ts";
import { requireCourseMilestoneMastery } from "../app/lib/courseProgress.ts";
import { normalizePartialCourseToc } from "../app/lib/courseTocStream.ts";
import { DEFAULT_OPENROUTER_LEARN_MODEL } from "../app/lib/openRouter.ts";

test("ensureCourseChatTurnHasLearnerQuestion creates first-milestone content for empty output", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.doesNotMatch(result.text, /^#{1,6}\s+/u);
  assert.doesNotMatch(result.text, /Why PPO Needs an Entropy Term/u);
  assert.match(result.text, /Explain why entropy/u);
  assert.equal(result.widgets[0]?.question, "What is the main idea of this milestone in your own words?");
  assert.equal(result.appendedText, result.text);
});

test("ensureCourseChatTurnHasLearnerQuestion appends checkpoint to lesson without a question", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Entropy regularization rewards a policy for keeping action probabilities spread out.",
    pageTitle: "Why PPO Needs an Entropy Term",
    pageObjective: "Explain why entropy keeps PPO policy updates exploratory.",
  });

  assert.match(result.text, /Entropy regularization rewards/u);
  assert.equal(result.widgets[0]?.type, "free_text");
  assert.equal(result.widgets[0]?.question, "What is the main idea of this milestone in your own words?");
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

  assert.match(result.text, /PPO constrains updates/u);
  assert.doesNotMatch(result.text, /In your own/u);
  assert.equal(result.widgets[0]?.question, "What is the main idea of this milestone in your own words?");
  assert.equal(result.widgets[0]?.type, "free_text");
});

test("ensureCourseChatTurnHasLearnerQuestion repairs mid-word truncation", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Advantage says whether that action was better or worse than expec",
    pageTitle: "Policy Gradient Loss Refresher",
    pageObjective: "Review how advantages shape policy updates.",
  });

  assert.doesNotMatch(result.text, /expec/u);
  assert.match(result.text, /This milestone is about/u);
  assert.equal(result.widgets[0]?.question, "What is the main idea of this milestone in your own words?");
});

test("ensureCourseChatTurnHasLearnerQuestion removes partial widget before fallback", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "Flattening an image loses spatial structure.",
      "",
      '{"type":"multiple_choice","id"',
    ].join("\n"),
    pageTitle: "Fully Connected Networks and Images",
    pageObjective: "Explain why flattening images hurts MLPs.",
  });

  assert.equal(result.widgets.length, 1);
  assert.equal(
    result.widgets[0]?.question,
    "What is the main idea of this milestone in your own words?",
  );
  assert.doesNotMatch(result.text, /multiple_choice/u);
});

test("ensureCourseChatTurnHasLearnerQuestion trims capped trailing fragments", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "Pixels are numbers arranged in a grid.",
      "",
      "If the image is 100 pixels wide and 10.",
    ].join("\n\n"),
    pageTitle: "How Computers See Images",
    pageObjective: "Explain how pixels form image grids.",
    stripTrailingPartialContent: true,
  });

  assert.match(result.text, /Pixels are numbers arranged in a grid/u);
  assert.doesNotMatch(result.text, /100 pixels wide and 10/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion trims non-capped dangling sentence fragments", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "An image is not a smooth picture to a computer, but a giant grid of numbers called a matrix. For a simple black-and-white image, this",
    pageTitle: "How Computers See Images",
    pageObjective:
      "Understand how images are represented as pixel grids and channels.",
  });

  assert.match(result.text, /giant grid of numbers called a matrix/u);
  assert.doesNotMatch(result.text, /black-and-white image, this/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion trims capped single-paragraph final sentence", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "A molded part may have extra material called a tail. A machine cuts it off, but sometimes the blade.",
    pageTitle: "Tail Trim Challenge",
    pageObjective: "Explain why tail trim inspection is hard.",
    stripTrailingPartialContent: true,
  });

  assert.match(result.text, /extra material called a tail/u);
  assert.doesNotMatch(result.text, /sometimes the blade/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion uses generic fallback for capped single-sentence fragments", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: "Let's ask a multiple-choice question about what a specific pixel value looks like.",
    pageTitle: "How Computers See Images",
    pageObjective:
      "Understand how images are represented as pixel grids and channels.",
    stripTrailingPartialContent: true,
  });

  assert.doesNotMatch(result.text, /Let's ask/u);
  assert.match(result.text, /This milestone is about/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion keeps pre-widget content when capped", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "Flattening an image loses spatial structure.",
      "",
      '{"type":"multiple_choice","id"',
    ].join("\n"),
    pageTitle: "Fully Connected Networks and Images",
    pageObjective: "Explain why flattening images hurts MLPs.",
    stripTrailingPartialContent: true,
  });

  assert.match(result.text, /Flattening an image loses spatial structure/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion removes leaked widget JSON fragments", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: '0, what color does the computer display for that pixel?","choices":[{"id":"A","text":"Pure white"},{"id":"B","text":"Pure black.',
    pageTitle: "How Computers See Images",
    pageObjective:
      "Understand how images are represented as pixel grids and channels.",
    stripTrailingPartialContent: true,
  });

  assert.doesNotMatch(result.text, /choices/u);
  assert.match(result.text, /This milestone is about/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion removes leaked tutor meta commentary", () => {
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "Pixels are tiny squares of color arranged in a grid. RGB channels store separate red, green, and blue values for each pixel.",
      "",
      "Total words: ~118 words. Perfect. Fits the 120-180 range well.",
    ].join("\n\n"),
    pageTitle: "How Computers See Images",
    pageObjective:
      "Understand how images are represented as pixel grids and channels.",
    stripTrailingPartialContent: true,
  });

  assert.match(result.text, /Pixels are tiny squares/u);
  assert.doesNotMatch(result.text, /Total words/u);
  assert.doesNotMatch(result.text, /Perfect\. Fits/u);
  assert.equal(result.widgets.length, 1);
});

test("ensureCourseChatTurnHasLearnerQuestion sanitizes complete widget turns", () => {
  const widget = {
    type: "free_text" as const,
    id: "sql-split-check",
    question: "Why do databases split related data into multiple tables?",
  };
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      ":**",
      "",
      "Goal: Test the core risk/understanding. Why do we split tables?",
    ].join("\n"),
    widgets: [widget],
    pageTitle: "The Problem: Why Databases Split Data",
    pageObjective:
      "Understand why relational databases use multiple tables and joins.",
  });

  assert.doesNotMatch(result.text, /Goal: Test/u);
  assert.doesNotMatch(result.text, /:\*\*/u);
  assert.match(result.text, /This milestone is about/u);
  assert.equal(result.widgets.length, 1);
  assert.equal(result.widgets[0]?.id, "sql-split-check");
});

test("ensureCourseChatTurnHasLearnerQuestion removes visible widget-planning prose", () => {
  const widget = {
    type: "free_text" as const,
    id: "sql-redundancy-check",
    question: "Why can repeated table data cause problems?",
  };
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "redundancy/errors).",
      "",
      "Let's use a multiple-choice question to contrast the confusion.",
      "",
      'Question: "If an online store repeats customer addresses in every order row, what problem appears?"',
    ].join("\n"),
    widgets: [widget],
    pageTitle: "The Problem: Why Databases Split Data",
    pageObjective:
      "Understand why relational databases use multiple tables and joins.",
  });

  assert.doesNotMatch(result.text, /redundancy\/errors/u);
  assert.doesNotMatch(result.text, /Let's use a multiple-choice/u);
  assert.doesNotMatch(result.text, /Question: "If/u);
  assert.match(result.text, /This milestone is about/u);
  assert.equal(result.widgets.length, 1);
  assert.equal(result.widgets[0]?.id, "sql-redundancy-check");
});

test("ensureCourseChatTurnHasLearnerQuestion preserves valid complete widget teaching paragraphs", () => {
  const widget = {
    type: "free_text" as const,
    id: "join-purpose-check",
    question: "Why do SQL joins matter?",
  };
  const result = ensureCourseChatTurnHasLearnerQuestion({
    text: [
      "A database often splits information into separate tables to avoid repeating the same facts in many rows.",
      "",
      "A join brings those related rows back together when a question needs both pieces of data.",
    ].join("\n"),
    widgets: [widget],
    pageTitle: "The Problem: Why Databases Split Data",
    pageObjective:
      "Understand why relational databases use multiple tables and joins.",
  });

  assert.match(result.text, /avoid repeating the same facts/u);
  assert.match(result.text, /A join brings those related rows back together/u);
  assert.equal(result.widgets.length, 1);
  assert.equal(result.widgets[0]?.id, "join-purpose-check");
});

test("isCourseChatTurnComplete accepts terminal questions and multiple choice", () => {
  assert.equal(isCourseChatTurnComplete("Why does that matter for PPO?"), true);
  assert.equal(
    isCourseChatTurnComplete(
      "Entropy keeps the policy exploratory.",
      [
        {
          type: "free_text",
          id: "entropy-check",
          question: "Why does entropy matter for PPO exploration?",
        },
      ],
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

test("parseCourseAnswerDecisionToolResult parses attempt and progress in one response", () => {
  const result = parseCourseAnswerDecisionToolResult(
    JSON.stringify({
      questionAttempt: {
        toolCall: "record_course_question_attempt",
        question: "Why does PPO clip policy ratios?",
        answer: "To keep updates bounded.",
        answerSummary: "Learner said clipping bounds updates.",
        conciseAnswer: "It bounds policy updates.",
        correctAnswer:
          "PPO clips ratios to limit how far the new policy moves from the old policy.",
        justification: "Correct.",
        score: 10,
      },
      progressDecision: {
        toolCall: "mark_milestone_done",
        reason: "The learner stated the stabilizing mechanism.",
      },
    }),
    "fallback answer",
  );

  assert.equal(
    result.questionAttempt.toolCall,
    "record_course_question_attempt",
  );
  assert.equal(result.progressDecision.toolCall, "mark_milestone_done");

  if (result.questionAttempt.toolCall === "record_course_question_attempt") {
    assert.equal(result.questionAttempt.answer, "fallback answer");
    assert.equal(result.questionAttempt.score, 10);
  }
});

test("parseCourseAnswerDecisionToolResult maps deterministic widget choices", () => {
  const selectedAnswer =
    "The sampled action is now half as likely under the new policy";
  const result = parseCourseAnswerDecisionToolResult(
    JSON.stringify({
      questionAttempt: {
        toolCall: "record_course_question_attempt",
        question: "What does a PPO ratio r = 0.5 mean?",
        answer: "B",
        answerSummary: "Learner selected B.",
        conciseAnswer: selectedAnswer,
        correctAnswer: selectedAnswer,
        justification: "Correct.",
        score: 10,
      },
      progressDecision: {
        toolCall: "mark_milestone_done",
        reason: "The learner selected the correct interpretation.",
      },
    }),
    "B",
    formatCourseQuestionWidgetForPrompt({
      type: "multiple_choice",
      id: "ratio-check",
      question: "What does a PPO ratio r = 0.5 mean?",
      choices: [
        {
          id: "A",
          text: "The sampled action is now twice as likely under the new policy",
        },
        { id: "B", text: selectedAnswer },
      ],
    }),
  );

  assert.equal(
    result.questionAttempt.toolCall,
    "record_course_question_attempt",
  );

  if (result.questionAttempt.toolCall === "record_course_question_attempt") {
    assert.equal(result.questionAttempt.answer, selectedAnswer);
  }
});

test("generateCourseAnswerDecision sends compact widget prompt", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  const widget = {
    type: "free_text" as const,
    id: "cnn-check",
    question:
      "Explain why CNNs are effective for images by describing three key reasons.",
    placeholder: "Type your answer here...",
  };
  const answer =
    "They detect local patterns, preserve spatial structure, and share weights.";
  const course = {
    id: "course_1",
    userId: "user_1",
    topicPrompt: "Learn CNNs",
    title: "CNNs",
    description: "Learn convolutional neural networks.",
    toc: {
      title: "CNNs",
      description: "Learn convolutional neural networks.",
      pages: [
        {
          title: "CNN Inductive Bias",
          objective:
            "Explain why local patterns, spatial structure, and shared weights make CNNs effective.",
        },
      ],
    },
    status: "active" as const,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: 1,
    generatedPages: 1,
    chatMessageCount: 2,
    conversationCost: 0,
    createdAt: 1,
    updatedAt: 1,
    pages: [],
    chatMessages: [],
  };

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                questionAttempt: {
                  toolCall: "record_course_question_attempt",
                  question: widget.question,
                  answer,
                  answerSummary: "Learner named the three core CNN biases.",
                  conciseAnswer: "Local patterns, spatial structure, shared weights.",
                  correctAnswer:
                    "CNNs use locality, spatial structure, and shared filters.",
                  justification: "Correct.",
                  score: 10,
                },
                progressDecision: {
                  toolCall: "mark_milestone_done",
                  reason: "The learner named all three core reasons.",
                },
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 220,
          completion_tokens: 80,
          total_tokens: 300,
          cost: 0.0001,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const result = await generateCourseAnswerDecision({
      apiKey: "test-key",
      model: "inception/mercury-2",
      userId: "user_1",
      course,
      messages: [
        {
          role: "assistant",
          content: [
            "CNNs work well because the same local visual patterns can recur across an image.",
            "This long filler represents lesson context that should be trimmed. ".repeat(
              80,
            ),
          ].join("\n\n"),
          toolCalls: [courseQuestionWidgetToolCallFromWidget(widget)],
        },
        {
          role: "user",
          content: answer,
          widgetAnswer: {
            question: widget.question,
            widgetId: widget.id,
            answer,
          },
        },
      ],
    });

    assert.equal(result.questionAttempt.toolCall, "record_course_question_attempt");
    assert.ok(requestBody);
    const capturedBody = requestBody as Record<string, unknown>;
    assert.equal(capturedBody.max_tokens, 320);
    assert.equal(
      capturedBody.session_id,
      "learn:user_1:course-answer-decision-v2",
    );

    const messages = capturedBody.messages as Array<{
      content:
        | string
        | Array<{
            type?: string;
            text?: string;
            cache_control?: { type?: string };
          }>;
    }>;
    const systemContent = messages[0]?.content;
    assert.ok(Array.isArray(systemContent));
    assert.equal(systemContent[0]?.cache_control?.type, "ephemeral");
    const systemPrompt = systemContent[0]?.text ?? "";
    const userContent = messages[1]?.content;
    assert.ok(Array.isArray(userContent));
    assert.equal(userContent[0]?.cache_control, undefined);
    const userPrompt = userContent[0]?.text ?? "";

    assert.match(systemPrompt, /under 16 words/u);
    assert.doesNotMatch(systemPrompt, /Course title:/u);
    assert.doesNotMatch(systemPrompt, /Learner answer:/u);
    assert.match(
      userPrompt,
      /^Grade the latest learner answer using the dynamic Learn context below\./u,
    );
    assert.match(userPrompt, /Answered widget JSON/u);
    assert.match(userPrompt, /Learner answer: They detect local patterns/u);
    assert.doesNotMatch(userPrompt, /Recent conversation JSON/u);
    assert.ok(userPrompt.length < 1_900);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateCourseToc keeps static instructions before dynamic topic", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "PPO for Beginners",
                description: "Learn PPO from first principles.",
                pages: [
                  {
                    title: "What PPO Optimizes",
                    objective: "Explain PPO's policy optimization goal.",
                  },
                  {
                    title: "Why Clipping Helps",
                    objective: "Explain why PPO limits policy updates.",
                  },
                ],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 180,
          completion_tokens: 80,
          total_tokens: 260,
          cost: 0.0001,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const toc = await generateCourseToc({
      apiKey: "test-key",
      userId: "user_1",
      topic: "Proximal Policy Optimization (PPO) for beginners",
    });

    assert.equal(toc.title, "PPO for Beginners");
    assert.ok(requestBody);

    const capturedBody = requestBody as Record<string, unknown>;
    assert.equal(capturedBody.model, DEFAULT_OPENROUTER_LEARN_MODEL);
    const messages = capturedBody.messages as Array<{
      role: string;
      content: string;
    }>;
    const userPrompt = messages[1]?.content ?? "";
    const topicIndex = userPrompt.indexOf("Topic: Proximal Policy Optimization");

    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
    assert.match(userPrompt, /^Create a mini-course table of contents\./u);
    assert.ok(topicIndex > userPrompt.indexOf("Keep titles specific"));
    assert.ok(userPrompt.trim().endsWith("Topic: Proximal Policy Optimization (PPO) for beginners"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamCourseChatTurn uses structured widget tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requestBody: Record<string, unknown> | null = null;
  const deltas: string[] = [];
  let pendingWidgetToolDeltas = 0;
  const course = {
    id: "course_1",
    userId: "user_1",
    topicPrompt: "Learn PPO",
    title: "PPO",
    description: "Learn Proximal Policy Optimization.",
    toc: {
      title: "PPO",
      description: "Learn Proximal Policy Optimization.",
      pages: [
        {
          title: "PPO Purpose",
          objective: "Explain what PPO is used for.",
        },
      ],
    },
    status: "active" as const,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: 1,
    generatedPages: 1,
    chatMessageCount: 0,
    conversationCost: 0,
    createdAt: 1,
    updatedAt: 1,
    pages: [],
    chatMessages: [],
  };

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content:
                        "PPO is a policy-gradient method that updates behavior carefully.",
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_ppo",
                          type: "function",
                          function: {
                            name: "render_question_widget",
                            arguments:
                              "{\"type\":\"free_text\",\"id\":\"ppo-purpose\",\"question\":\"What is PPO used for?\"}",
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 300,
                  completion_tokens: 80,
                  total_tokens: 380,
                  cost: 0.001,
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };

  try {
    const result = await streamCourseChatTurn({
      apiKey: "test-key",
      model: "google/gemini-3.1-flash-lite",
      userId: "user_1",
      course,
      messages: [],
      onTextDelta(delta) {
        deltas.push(delta);
      },
      onQuestionWidgetToolDelta() {
        pendingWidgetToolDeltas += 1;
      },
    });

    assert.ok(requestBody);
    const capturedBody = requestBody as Record<string, unknown>;
    assert.equal(capturedBody.session_id, "learn:user_1:course-chat-v9");
    assert.deepEqual(
      (capturedBody as { tools?: unknown[] }).tools?.[0],
      {
        type: "function",
        function: {
          name: "render_question_widget",
          description:
            "Render one learner-facing Waxon question widget after the tutor explanation.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: {
                type: "string",
                enum: ["free_text", "multiple_choice"],
              },
              id: {
                type: "string",
                description: "Short stable identifier for this question.",
              },
              question: {
                type: "string",
                description: "Self-contained learner-facing question.",
              },
              placeholder: {
                type: "string",
                description: "Placeholder text for free-text widgets.",
              },
              choices: {
                type: "array",
                description:
                  "Answer choices for multiple-choice widgets. Use A, B, C, D ids.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: "string",
                      description: "Choice id such as A, B, C, or D.",
                    },
                    text: {
                      type: "string",
                      description: "Choice text.",
                    },
                  },
                  required: ["id", "text"],
                },
              },
            },
            required: ["type", "id", "question"],
          },
        },
      },
    );
    const requestMessages = capturedBody.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const systemContent = requestMessages[0]?.content;
    const userContent = requestMessages[1]?.content as Array<
      Record<string, unknown>
    >;

    assert.equal(typeof systemContent, "string");
    assert.deepEqual(userContent[0]?.cache_control, { type: "ephemeral" });
    assert.equal(
      JSON.stringify(capturedBody).match(/cache_control/gu)?.length,
      1,
    );
    assert.match(String(userContent[0]?.text), /Stable tutor instructions/u);
    assert.match(
      String(userContent[0]?.text),
      /End every non-completion turn by calling render_question_widget/u,
    );
    assert.ok(String(userContent[0]?.text).length > 21_000);
    assert.doesNotMatch(String(userContent[0]?.text), /Course title: PPO/u);
    assert.doesNotMatch(String(userContent[0]?.text), /Recent conversation JSON/u);
    assert.match(String(userContent[1]?.text), /Course title: PPO/u);
    assert.match(String(userContent[1]?.text), /Recent conversation JSON/u);
    assert.equal((requestBody as { tool_choice?: unknown }).tool_choice, "auto");
    assert.equal(
      (requestBody as { parallel_tool_calls?: unknown }).parallel_tool_calls,
      false,
    );
    assert.equal(
      (requestBody as { reasoning_effort?: unknown }).reasoning_effort,
      "minimal",
    );
    assert.equal(
      result.content,
      "PPO is a policy-gradient method that updates behavior carefully.",
    );
    assert.equal(result.toolCalls[0]?.function.arguments.id, "ppo-purpose");
    assert.equal(result.toolCalls[0]?.function.arguments.question, "What is PPO used for?");
    assert.deepEqual(deltas, [
      "PPO is a policy-gradient method that updates behavior carefully.",
    ]);
    assert.equal(pendingWidgetToolDeltas, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamCourseAnswerContinuation uses one cached stream for evaluation and next widget", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let requestBody: Record<string, unknown> | null = null;
  const events: string[] = [];
  let pendingWidgetToolDeltas = 0;
  const widget = {
    type: "free_text" as const,
    id: "sql-redundancy",
    question: "Why can repeated customer data cause update problems?",
    placeholder: "Explain the problem...",
  };
  const course = {
    id: "course_1",
    userId: "user_1",
    topicPrompt: "Learn SQL joins",
    title: "SQL Joins",
    description: "Learn joins and normalization.",
    toc: {
      title: "SQL Joins",
      description: "Learn joins and normalization.",
      pages: [
        {
          title: "Why Relationships Matter",
          objective: "Explain why related tables reduce duplication.",
        },
        {
          title: "How Joins Use Keys",
          objective: "Explain how matching keys combine rows.",
        },
      ],
    },
    status: "active" as const,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: 2,
    generatedPages: 2,
    chatMessageCount: 2,
    conversationCost: 0,
    createdAt: 1,
    updatedAt: 1,
    pages: [],
    chatMessages: [],
  };

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_decision",
                          type: "function",
                          function: {
                            name: "record_course_answer_decision",
                            arguments: JSON.stringify({
                              questionAttempt: {
                                toolCall: "record_course_question_attempt",
                                question:
                                  "Why can repeated customer data cause update problems?",
                                answer:
                                  "You have to update it in many rows and can miss one.",
                                answerSummary:
                                  "Repeated rows make updates inconsistent.",
                                conciseAnswer:
                                  "Repeated data can become inconsistent.",
                                correctAnswer:
                                  "Update one fact in many places risks inconsistency.",
                                justification:
                                  "Names duplication and update inconsistency.",
                                score: 9,
                              },
                              progressDecision: {
                                toolCall: "mark_milestone_done",
                                reason: "The learner explained the core risk.",
                              },
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content:
                        "Good. A join uses matching keys to combine related rows only when you query them.",
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 1,
                          id: "call_widget",
                          type: "function",
                          function: {
                            name: "render_question_widget",
                            arguments:
                              "{\"type\":\"free_text\",\"id\":\"join-key\",\"question\":\"What has to match for a join to connect two rows?\"}",
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 5200,
                  completion_tokens: 160,
                  total_tokens: 5360,
                  prompt_tokens_details: {
                    cached_tokens: 4897,
                    cache_write_tokens: 0,
                  },
                  cost: 0.001,
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };

  try {
    const result = await streamCourseAnswerContinuation({
      apiKey: "test-key",
      model: "google/gemini-3.1-flash-lite",
      userId: "user_1",
      course,
      messages: [
        {
          role: "assistant",
          content:
            "Repeated data means you must update one fact in many places.",
          toolCalls: [courseQuestionWidgetToolCallFromWidget(widget)],
        },
        {
          role: "user",
          content: "You have to update it in many rows and can miss one.",
          widgetAnswer: {
            question: widget.question,
            widgetId: widget.id,
            answer: "You have to update it in many rows and can miss one.",
          },
        },
      ],
      onAnswerDecision(decision) {
        events.push(`decision:${decision.progressDecision.toolCall}`);
      },
      onTextDelta(delta) {
        events.push(`delta:${delta}`);
      },
      onQuestionWidgetToolDelta() {
        pendingWidgetToolDeltas += 1;
      },
    });

    assert.ok(requestBody);
    const capturedBody = requestBody as Record<string, unknown>;
    assert.equal(capturedBody.session_id, "learn:user_1:course-chat-v9");
    assert.equal(capturedBody.parallel_tool_calls, true);
    assert.deepEqual(
      (capturedBody as { tools?: Array<{ function?: { name?: string } }> })
        .tools?.map((tool) => tool.function?.name),
      ["record_course_answer_decision", "render_question_widget"],
    );
    const answerDecisionTool = (
      capturedBody as { tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, { required?: string[] }> } } }> }
    ).tools?.find(
      (tool) => tool.function?.name === "record_course_answer_decision",
    );

    assert.ok(
      answerDecisionTool?.function?.parameters?.properties?.questionAttempt
        ?.required?.includes("score"),
    );

    const requestMessages = capturedBody.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userContent = requestMessages[1]?.content as Array<
      Record<string, unknown>
    >;

    assert.deepEqual(userContent[0]?.cache_control, { type: "ephemeral" });
    assert.match(String(userContent[0]?.text), /Stable tutor instructions/u);
    assert.match(
      String(userContent[0]?.text),
      /record_course_answer_decision/u,
    );
    assert.doesNotMatch(String(userContent[0]?.text), /Learner answer:/u);
    assert.match(String(userContent[1]?.text), /Learner answer:/u);
    assert.match(String(userContent[1]?.text), /Recent conversation JSON/u);
    assert.deepEqual(events, [
      "decision:mark_milestone_done",
      "delta:Good. A join uses matching keys to combine related rows only when you query them.",
    ]);
    assert.equal(result.answerDecision.questionAttempt.toolCall, "record_course_question_attempt");
    assert.equal(result.answerDecision.questionAttempt.score, 9);
    assert.equal(result.toolCalls[0]?.function.arguments.id, "join-key");
    assert.equal(pendingWidgetToolDeltas, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamCourseAnswerContinuation rejects malformed answer decision tools", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const widget = {
    type: "free_text" as const,
    id: "sql-redundancy",
    question: "Why can repeated customer data cause update problems?",
  };
  const course = {
    id: "course_1",
    userId: "user_1",
    topicPrompt: "Learn SQL joins",
    title: "SQL Joins",
    description: "Learn joins and normalization.",
    toc: {
      title: "SQL Joins",
      description: "Learn joins and normalization.",
      pages: [
        {
          title: "Why Relationships Matter",
          objective: "Explain why related tables reduce duplication.",
        },
      ],
    },
    status: "active" as const,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: 1,
    generatedPages: 1,
    chatMessageCount: 2,
    conversationCost: 0,
    createdAt: 1,
    updatedAt: 1,
    pages: [],
    chatMessages: [],
  };

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_decision",
                          type: "function",
                          function: {
                            name: "record_course_answer_decision",
                            arguments: JSON.stringify({
                              questionAttempt: {
                                toolCall: "record_course_question_attempt",
                                question:
                                  "Why can repeated customer data cause update problems?",
                                answer:
                                  "You have to update it in many rows.",
                                answerSummary:
                                  "Repeated rows make updates harder.",
                                conciseAnswer:
                                  "Repeated data can become inconsistent.",
                                correctAnswer:
                                  "Update one fact in many places risks inconsistency.",
                                justification: "Missing a numeric score.",
                              },
                              progressDecision: {
                                toolCall: "continue_current_milestone",
                                reason: "Missing score.",
                              },
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );

  try {
    await assert.rejects(
      () =>
        streamCourseAnswerContinuation({
          apiKey: "test-key",
          model: "google/gemini-3.1-flash-lite",
          userId: "user_1",
          course,
          messages: [
            {
              role: "assistant",
              content:
                "Repeated data means you must update one fact in many places.",
              toolCalls: [courseQuestionWidgetToolCallFromWidget(widget)],
            },
            {
              role: "user",
              content: "You have to update it in many rows.",
              widgetAnswer: {
                question: widget.question,
                widgetId: widget.id,
                answer: "You have to update it in many rows.",
              },
            },
          ],
          onTextDelta() {},
        }),
      /score/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamCourseChatTurn keeps the same cache-capable session key across Learn courses", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const sessionIds: string[] = [];
  const baseCourse = {
    id: "draft-course",
    userId: "user_1",
    topicPrompt: "Learn PPO",
    title: "PPO",
    description: "Learn Proximal Policy Optimization.",
    toc: {
      title: "PPO",
      description: "Learn Proximal Policy Optimization.",
      pages: [
        {
          title: "PPO Purpose",
          objective: "Explain what PPO is used for.",
        },
      ],
    },
    status: "active" as const,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    totalPages: 1,
    generatedPages: 1,
    chatMessageCount: 0,
    conversationCost: 0,
    createdAt: 1,
    updatedAt: 1,
    pages: [],
    chatMessages: [],
  };

  globalThis.fetch = async (_url, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
      session_id?: string;
    };
    sessionIds.push(requestBody.session_id ?? "");

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      content: "PPO keeps policy updates conservative.",
                    },
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };

  try {
    await streamCourseChatTurn({
      apiKey: "test-key",
      model: "google/gemini-3.1-flash-lite",
      userId: "user_1",
      course: baseCourse,
      messages: [],
      onTextDelta() {},
    });
    await streamCourseChatTurn({
      apiKey: "test-key",
      model: "google/gemini-3.1-flash-lite",
      userId: "user_1",
      course: {
        ...baseCourse,
        id: "persisted-course-1",
      },
      messages: [],
      onTextDelta() {},
    });

    assert.equal(sessionIds.length, 2);
    assert.equal(sessionIds[0], sessionIds[1]);
    assert.equal(sessionIds[0], "learn:user_1:course-chat-v9");
  } finally {
    globalThis.fetch = originalFetch;
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

test("parseCourseQuestionAttemptToolResult reads choices from structured question widget context", () => {
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
    formatCourseQuestionWidgetForPrompt({
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
