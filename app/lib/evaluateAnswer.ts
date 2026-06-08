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
} from "./evaluateAnswerParsing";
import type { EvaluationResult } from "./evaluateAnswerParsing";

export {
  failedEvaluation,
  type EvaluationResult,
  type FailedEvaluationResult,
  type GradedEvaluationResult,
} from "./evaluateAnswerParsing";

export type EvaluateAnswerInput = {
  question: string;
  answer: string;
  previousReviews: string;
  expectedAnswer?: string | null;
  userId?: string | null;
  deckId?: string | null;
  traceId?: string | null;
  onActivity?: () => void;
};

export const EVALUATION_TIMEOUT_MS = 60_000;
const BROWSER_SMOKE_CORRECT_TOKEN = "browser-smoke-correct-token";

function normalizeExactAnswer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function evaluateExactExpectedAnswer(
  input: EvaluateAnswerInput,
): EvaluationResult | null {
  const expectedAnswer = input.expectedAnswer?.trim();

  if (!expectedAnswer) {
    return null;
  }

  if (normalizeExactAnswer(input.answer) !== normalizeExactAnswer(expectedAnswer)) {
    return null;
  }

  return {
    status: "graded",
    score: 10,
    justification: "Matches the expected answer.",
    answerSummary: input.answer.trim().slice(0, 120) || expectedAnswer,
  };
}

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

function buildSystemPrompt(): string {
  return `You are grading a free-text recall answer.

Grade the answer from 0 to 10.

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

Return strict JSON only:
{
  "score": number,
  "justification": string,
  "answerSummary": string
}`;
}

function buildUserPrompt(input: EvaluateAnswerInput): string {
  return [
    "Grade this submitted flashcard answer.",
    `Question: ${input.question}`,
    `User answer: ${input.answer}`,
    `Previous review history: ${input.previousReviews}`,
  ].join("\n\n");
}

export async function evaluateAnswer(
  input: EvaluateAnswerInput,
): Promise<EvaluationResult> {
  const exactEvaluation = evaluateExactExpectedAnswer(input);

  if (exactEvaluation) {
    const traceId = input.traceId ?? crypto.randomUUID();
    const pendingTrace = beginLlmTrace({
      traceId,
      operation: "evaluate_answer_exact_match",
      model: "deterministic-exact-match",
      question: input.question,
      requestBody: {
        question: input.question,
        answer: input.answer,
        expectedAnswer: input.expectedAnswer,
      },
    });

    await finishLlmTrace(pendingTrace, {
      ok: true,
      responseBody: exactEvaluation,
      usage: {
        prompt_tokens:
          input.question.length +
          input.answer.length +
          (input.expectedAnswer?.length ?? 0),
        completion_tokens: exactEvaluation.justification.length,
        total_tokens:
          input.question.length +
          input.answer.length +
          (input.expectedAnswer?.length ?? 0) +
          exactEvaluation.justification.length,
        cost: 0,
      },
    });

    return exactEvaluation;
  }

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
            content: buildUserPrompt(input),
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
