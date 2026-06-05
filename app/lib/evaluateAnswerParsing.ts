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

const MAX_JUSTIFICATION_WORDS = 12;
const MAX_ANSWER_SUMMARY_WORDS = 12;
const MAX_PROBING_QUESTIONS = 3;
const MAX_PROBING_QUESTION_CHARS = 220;
export const PROBING_QUESTION_SCORE_THRESHOLD = 5;

export function parseScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

export function parseEvaluation(
  rawText: string,
  fallbackAnswer: string,
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

export function failedEvaluation(
  justification: string,
  fallbackAnswer: string,
): FailedEvaluationResult {
  return {
    ...FAILED_EVALUATION_RESULT,
    justification,
    answerSummary: conciseAnswerSummary(fallbackAnswer, fallbackAnswer),
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
