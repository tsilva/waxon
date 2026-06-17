import { formatFormulaMarkdown } from "./markdownFormulaFormatting.ts";

export type GradedEvaluationResult = {
  status: "graded";
  score: number;
  justification: string;
  answerSummary: string;
  correctAnswer: string | null;
};

export type FailedEvaluationResult = {
  status: "failed";
  score: null;
  justification: string;
  answerSummary: string;
  correctAnswer: null;
};

export type EvaluationResult = GradedEvaluationResult | FailedEvaluationResult;

const FAILED_EVALUATION_RESULT: Omit<
  FailedEvaluationResult,
  "answerSummary" | "correctAnswer"
> = {
  status: "failed",
  score: null,
  justification: "LLM evaluation failed or returned invalid JSON.",
};

const MAX_JUSTIFICATION_WORDS = 12;
const MAX_ANSWER_SUMMARY_WORDS = 12;
const MAX_CORRECT_ANSWER_WORDS = 24;

export function parseScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

export function parseEvaluation(
  rawText: string,
  fallbackAnswer: string,
  fallbackCorrectAnswer: string | null = null,
): EvaluationResult {
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
      correctAnswer?: unknown;
      correct_answer?: unknown;
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
        parsed.answerSummary ?? parsed.answer_summary,
        fallbackAnswer,
      ),
      correctAnswer: conciseCorrectAnswer(
        parsed.correctAnswer ?? parsed.correct_answer ?? parsed.conciseAnswer,
        fallbackCorrectAnswer,
      ),
    };
  } catch {
    return failedEvaluation(
      FAILED_EVALUATION_RESULT.justification,
      fallbackAnswer,
    );
  }
}

export function failedEvaluation(
  justification: string,
  fallbackAnswer: string,
): FailedEvaluationResult {
  return {
    ...FAILED_EVALUATION_RESULT,
    justification,
    answerSummary: conciseAnswerSummary(fallbackAnswer, fallbackAnswer),
    correctAnswer: null,
  };
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

function conciseCorrectAnswer(
  answer: unknown,
  fallbackCorrectAnswer: string | null,
): string | null {
  const source =
    typeof answer === "string" && answer.trim()
      ? answer
      : fallbackCorrectAnswer?.trim();

  if (!source) {
    return null;
  }

  const words = source.trim().replace(/\s+/g, " ").split(" ");

  if (words.length <= MAX_CORRECT_ANSWER_WORDS) {
    return formatFormulaMarkdown(words.join(" "));
  }

  return formatFormulaMarkdown(
    `${words.slice(0, MAX_CORRECT_ANSWER_WORDS).join(" ")}...`,
  );
}
