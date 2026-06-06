import { getQuestionQualityReference } from "./questionQualityReference";
import {
  beginLlmTrace,
  finishLlmTrace,
  recordFailedLlmTrace,
} from "./llmTraceStore";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
} from "./openRouter";
import {
  failedEvaluation,
  parseEvaluation,
  PROBING_QUESTION_SCORE_THRESHOLD,
} from "./evaluateAnswerParsing";
import type { EvaluationResult } from "./evaluateAnswerParsing";
import type { ExistingQuestionNeighbor } from "./questionNeighbors";

export {
  failedEvaluation,
  PROBING_QUESTION_SCORE_THRESHOLD,
  type EvaluationResult,
  type FailedEvaluationResult,
  type GradedEvaluationResult,
} from "./evaluateAnswerParsing";

export type EvaluateAnswerInput = {
  question: string;
  answer: string;
  previousReviews: string;
  userId?: string | null;
  deckId?: string | null;
  traceId?: string | null;
  onActivity?: () => void;
};

export const EVALUATION_TIMEOUT_MS = 60_000;
const BROWSER_SMOKE_CORRECT_TOKEN = "browser-smoke-correct-token";
const MAX_CONTEXT_TEXT_CHARS = 220;

function isBrowserSmokeEvaluatorEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR === "1"
  );
}

async function evaluateBrowserSmokeAnswer(
  input: EvaluateAnswerInput,
): Promise<EvaluationResult> {
  const normalizedAnswer = input.answer.trim().toLowerCase();
  const isCorrect = normalizedAnswer.includes(BROWSER_SMOKE_CORRECT_TOKEN);
  const result: EvaluationResult = {
    status: "graded",
    score: isCorrect ? 10 : 2,
    justification: isCorrect ? "Contains the expected smoke token." : "Missing the expected smoke token.",
    answerSummary: input.answer.trim() || "(blank)",
    probingQuestions: isCorrect
      ? []
      : ["What exact token should a browser smoke answer include?"],
  };
  const traceId = input.traceId ?? crypto.randomUUID();
  const pendingTrace = beginLlmTrace({
    traceId,
    operation: "evaluate_answer_browser_smoke",
    model: "deterministic-browser-smoke",
    question: input.question,
    requestBody: {
      question: input.question,
      answer: input.answer,
      expectedToken: BROWSER_SMOKE_CORRECT_TOKEN,
    },
  });

  await finishLlmTrace(pendingTrace, {
    ok: true,
    responseBody: result,
    usage: {
      prompt_tokens: input.question.length + input.answer.length,
      completion_tokens: result.justification.length,
      total_tokens:
        input.question.length + input.answer.length + result.justification.length,
      cost: 0,
    },
  });

  return result;
}

function truncateContextText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length <= MAX_CONTEXT_TEXT_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_CONTEXT_TEXT_CHARS - 3).trim()}...`;
}

function formatNeighborContext(neighbors: ExistingQuestionNeighbor[]): string {
  if (neighbors.length === 0) {
    return "No similar existing questions were available.";
  }

  return neighbors
    .map((neighbor, index) =>
      [
        `${index + 1}. Question: ${truncateContextText(neighbor.question)}`,
        `   Expected answer: ${
          neighbor.conciseAnswer
            ? truncateContextText(neighbor.conciseAnswer)
            : "(not available)"
        }`,
        `   Similarity: ${neighbor.similarity.toFixed(4)}`,
      ].join("\n"),
    )
    .join("\n");
}

function buildSystemPrompt(): string {
  const questionQualityReference = getQuestionQualityReference();

  return `You are grading a free-text recall answer.

Grade the answer from 0 to 10. In the same response, generate extra
probingQuestions only when the score is ${PROBING_QUESTION_SCORE_THRESHOLD} or
lower.

Scoring:
0 = no useful knowledge or completely wrong
1-3 = mostly wrong, major misconception
4-5 = partially correct but important gaps or confusion
6 = roughly correct but incomplete or uncertain
7 = acceptable recall with minor gaps
8 = good recall
9 = excellent recall
10 = complete, precise, confident answer

Also rewrite the user's answer as the answerSummary: what you understood
the user's answer to be, not the ideal corrected answer. Keep it concise,
faithful to the user's meaning, and 12 words maximum. Preserve important
math symbols or formulas.

Keep justification very concise: one sentence, 12 words maximum.

Shared question-quality reference for probingQuestions:
${questionQualityReference}

If score is ${PROBING_QUESTION_SCORE_THRESHOLD} or lower, include 0 to 3
probingQuestions. Generate a probing question only when both gates pass:
1. The user's answer directly demonstrates the specific misconception, missing
   step, gap, or confusion being tested.
2. The nearby existing deck questions do not already cover the same atomic
   recall target.
Do not generate prerequisite, adjacent, boundary-case, or "deeper" questions
unless the user's answer specifically demonstrates that uncovered gap. Each
probing question must follow the shared reference. If no candidate passes both
gates, probingQuestions must be an empty array. If score is above
${PROBING_QUESTION_SCORE_THRESHOLD}, probingQuestions must be an empty array.

Return strict JSON only:
{
  "score": number,
  "justification": string,
  "answerSummary": string,
  "probingQuestions": string[]
}`;
}

function buildUserPrompt(
  input: EvaluateAnswerInput,
  similarExistingQuestions: ExistingQuestionNeighbor[],
): string {
  return [
    "Grade this submitted flashcard answer.",
    `Question: ${input.question}`,
    `User answer: ${input.answer}`,
    `Previous review history: ${input.previousReviews}`,
    "Similar existing questions near the source question:",
    formatNeighborContext(similarExistingQuestions),
  ].join("\n\n");
}

async function loadSimilarExistingQuestionContext(
  input: EvaluateAnswerInput,
): Promise<ExistingQuestionNeighbor[]> {
  try {
    const { loadExistingQuestionNeighbors } = await import("./questionNeighbors");

    return await loadExistingQuestionNeighbors({
      question: input.question,
      deckId: input.deckId,
    });
  } catch (error) {
    console.info("[waxon] probing question neighbor retrieval skipped", {
      question: input.question,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return [];
  }
}

export async function evaluateAnswer(
  input: EvaluateAnswerInput,
): Promise<EvaluationResult> {
  if (isBrowserSmokeEvaluatorEnabled()) {
    return await evaluateBrowserSmokeAnswer(input);
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    const traceId = input.traceId ?? crypto.randomUUID();
    const error = new Error("OPENROUTER_API_KEY or LLM_API_KEY is not configured.");
    await recordFailedLlmTrace({
      traceId,
      operation: "evaluate_answer",
      model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
      question: input.question,
      requestBody: {
        question: input.question,
        answer: input.answer,
        previousReviews: input.previousReviews,
        configured: false,
      },
      error,
    });

    return failedEvaluation(
      error.message,
      input.answer,
    );
  }

  const similarExistingQuestions = await loadSimilarExistingQuestionContext(input);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimeout = () => {
    input.onActivity?.();
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);
  };

  resetIdleTimeout();

  try {
    const { response, body } = await openRouterChatCompletion({
      apiKey,
      signal: controller.signal,
      onActivity: resetIdleTimeout,
      trace: {
        operation: "evaluate_answer",
        userId: input.userId,
        deckId: input.deckId,
        question: input.question,
        traceId: input.traceId,
      },
      body: {
        model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          {
            role: "user",
            content: buildUserPrompt(input, similarExistingQuestions),
          },
        ],
        response_format: {
          type: "json_object",
        },
        stream: true,
        temperature: 0,
        max_tokens: 2_000,
      },
    });

    if (!response.ok) {
      console.info("[waxon] llm evaluation failed", {
        provider: "openrouter",
        model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
        status: response.status,
        statusText: response.statusText,
      });
      return failedEvaluation(
        "LLM evaluation failed before grading.",
        input.answer,
      );
    }

    return parseEvaluation(extractChatCompletionText(body), input.answer);
  } catch (error) {
    console.info("[waxon] llm evaluation failed", {
      provider: "openrouter",
      model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
      error: error instanceof Error ? error.message : "unknown error",
    });
    if (isAbortError(error)) {
      return failedEvaluation(
        `LLM evaluation timed out after ${Math.round(
          EVALUATION_TIMEOUT_MS / 1000,
        )}s while waiting for OpenRouter.`,
        input.answer,
      );
    }

    return failedEvaluation(
      "LLM evaluation failed or returned invalid JSON.",
      input.answer,
    );
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}
