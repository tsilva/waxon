import { getQuestionQualityReference } from "./questionQualityReference";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
} from "./openRouter";

export type EvaluateAnswerInput = {
  question: string;
  answer: string;
  previousReviews: string;
  userId?: string | null;
  deckId?: string | null;
};

export type GradedEvaluationResult = {
  status: "graded";
  score: number;
  justification: string;
  answerSummary: string;
  probingQuestions: string[];
};

export type FailedEvaluationResult = {
  status: "failed";
  score: null;
  justification: string;
  answerSummary: string;
  probingQuestions: [];
};

export type EvaluationResult = GradedEvaluationResult | FailedEvaluationResult;

const FAILED_EVALUATION_RESULT: Omit<
  FailedEvaluationResult,
  "answerSummary"
> = {
  status: "failed",
  score: null,
  justification: "LLM evaluation failed or returned invalid JSON.",
  probingQuestions: [],
};

const EVALUATION_TIMEOUT_MS = 25_000;
const MAX_JUSTIFICATION_WORDS = 12;
const MAX_ANSWER_SUMMARY_WORDS = 12;
const MAX_PROBING_QUESTIONS = 3;
const MAX_PROBING_QUESTION_CHARS = 220;
export const PROBING_QUESTION_SCORE_THRESHOLD = 5;

function parseScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

function buildPrompt(input: EvaluateAnswerInput): string {
  const questionQualityReference = getQuestionQualityReference();

  return `You are grading a free-text recall answer.

Question: ${input.question}

User answer: ${input.answer}

Previous review history: ${input.previousReviews}

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

If score is ${PROBING_QUESTION_SCORE_THRESHOLD} or lower, include 1 to 3
probingQuestions that directly test the specific misconception, missing step,
or confusion shown in the user's answer. Each probing question must follow the
shared reference. If score is above ${PROBING_QUESTION_SCORE_THRESHOLD},
probingQuestions must be an empty array.

Return strict JSON only:
{
  "score": number,
  "justification": string,
  "answerSummary": string,
  "probingQuestions": string[]
}`;
}

function parseEvaluation(rawText: string, fallbackAnswer: string): EvaluationResult {
  try {
    const json = rawText
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(json) as {
      score?: unknown;
      justification?: unknown;
      answerSummary?: unknown;
      answer_summary?: unknown;
      conciseAnswer?: unknown;
      probingQuestions?: unknown;
      probing_questions?: unknown;
    };
    const score = parseScore(parsed.score);

    if (score === null) {
      return failedEvaluation(
        "LLM evaluation failed or returned invalid score.",
        fallbackAnswer,
      );
    }

    return {
      status: "graded",
      score,
      justification: conciseJustification(parsed.justification),
      answerSummary: conciseAnswerSummary(
        parsed.answerSummary ?? parsed.answer_summary ?? parsed.conciseAnswer,
        fallbackAnswer,
      ),
      probingQuestions:
        score <= PROBING_QUESTION_SCORE_THRESHOLD
          ? sanitizeProbingQuestions(
              parsed.probingQuestions ?? parsed.probing_questions,
            )
          : [],
    };
  } catch {
    return failedEvaluation(
      FAILED_EVALUATION_RESULT.justification,
      fallbackAnswer,
    );
  }
}

function conciseJustification(justification: unknown): string {
  if (typeof justification !== "string" || !justification.trim()) {
    return FAILED_EVALUATION_RESULT.justification;
  }

  const words = justification.trim().replace(/\s+/g, " ").split(" ");

  if (words.length <= MAX_JUSTIFICATION_WORDS) {
    return words.join(" ");
  }

  return `${words.slice(0, MAX_JUSTIFICATION_WORDS).join(" ")}...`;
}

function failedEvaluation(
  justification: string,
  fallbackAnswer: string,
): FailedEvaluationResult {
  return {
    ...FAILED_EVALUATION_RESULT,
    justification,
    answerSummary: conciseAnswerSummary(fallbackAnswer, fallbackAnswer),
  };
}

function conciseAnswerSummary(summary: unknown, fallbackAnswer: string): string {
  const source =
    typeof summary === "string" && summary.trim()
      ? summary
      : fallbackAnswer.trim() || "(blank)";
  const words = source.trim().replace(/\s+/g, " ").split(" ");

  if (words.length <= MAX_ANSWER_SUMMARY_WORDS) {
    return words.join(" ");
  }

  return `${words.slice(0, MAX_ANSWER_SUMMARY_WORDS).join(" ")}...`;
}

function sanitizeProbingQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions)) {
    return [];
  }

  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const question of questions) {
    if (typeof question !== "string") {
      continue;
    }

    const normalized = question.trim().replace(/\s+/g, " ");

    if (!normalized || normalized.length > MAX_PROBING_QUESTION_CHARS) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sanitized.push(normalized);

    if (sanitized.length >= MAX_PROBING_QUESTIONS) {
      break;
    }
  }

  return sanitized;
}

export async function evaluateAnswer(
  input: EvaluateAnswerInput,
): Promise<EvaluationResult> {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return failedEvaluation(
      "OPENROUTER_API_KEY or LLM_API_KEY is not configured.",
      input.answer,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);

  try {
    const { response, body } = await openRouterChatCompletion({
      apiKey,
      signal: controller.signal,
      trace: {
        operation: "evaluate_answer",
        userId: input.userId,
        deckId: input.deckId,
        question: input.question,
      },
      body: {
        model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
        messages: [
          {
            role: "user",
            content: buildPrompt(input),
          },
        ],
        response_format: {
          type: "json_object",
        },
        temperature: 0,
        max_tokens: 500,
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
    return failedEvaluation(FAILED_EVALUATION_RESULT.justification, input.answer);
  } finally {
    clearTimeout(timeout);
  }
}
