export type EvaluateAnswerInput = {
  question: string;
  answer: string;
  previousReviews: string;
};

export type EvaluationResult = {
  score: number;
  justification: string;
  answerSummary: string;
};

const INVALID_JSON_RESULT: EvaluationResult = {
  score: 0,
  justification: "LLM evaluation failed or returned invalid JSON.",
  answerSummary: "Evaluation failed.",
};

const EVALUATION_TIMEOUT_MS = 25_000;
const MAX_JUSTIFICATION_WORDS = 12;
const MAX_ANSWER_SUMMARY_WORDS = 12;

function clampScore(score: unknown): number {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

function buildPrompt(input: EvaluateAnswerInput): string {
  return `You are grading a free-text recall answer.

Question: ${input.question}

User answer: ${input.answer}

Previous review history: ${input.previousReviews}

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
    };

    return {
      score: clampScore(parsed.score),
      justification: conciseJustification(parsed.justification),
      answerSummary: conciseAnswerSummary(
        parsed.answerSummary ?? parsed.answer_summary ?? parsed.conciseAnswer,
        fallbackAnswer,
      ),
    };
  } catch {
    return {
      ...INVALID_JSON_RESULT,
      answerSummary: conciseAnswerSummary(fallbackAnswer, fallbackAnswer),
    };
  }
}

function conciseJustification(justification: unknown): string {
  if (typeof justification !== "string" || !justification.trim()) {
    return INVALID_JSON_RESULT.justification;
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

function extractChatCompletionText(response: unknown): string {
  const body = response as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const candidate = part as { text?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

export async function evaluateAnswer(
  input: EvaluateAnswerInput,
): Promise<EvaluationResult> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;

  if (!apiKey) {
    return {
      score: 0,
      justification: "OPENROUTER_API_KEY or LLM_API_KEY is not configured.",
      answerSummary: conciseAnswerSummary(input.answer, input.answer),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "waxon",
      },
      body: JSON.stringify({
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
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.info("[waxon] llm evaluation failed", {
        provider: "openrouter",
        model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
        status: response.status,
        statusText: response.statusText,
        body: errorText.slice(0, 500),
      });
      return INVALID_JSON_RESULT;
    }

    const body: unknown = await response.json();
    return parseEvaluation(extractChatCompletionText(body), input.answer);
  } catch (error) {
    console.info("[waxon] llm evaluation failed", {
      provider: "openrouter",
      model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
      error: error instanceof Error ? error.message : "unknown error",
    });
    return {
      ...INVALID_JSON_RESULT,
      answerSummary: conciseAnswerSummary(input.answer, input.answer),
    };
  } finally {
    clearTimeout(timeout);
  }
}
