import {
  buildOpenRouterHeaders, OPENROUTER_CHAT_URL, resolveOpenRouterApiKey,
} from "./openrouter-config.mts";
import { evaluateRecall } from "../app/lib/v2/model.ts";
import { evaluateRecallWithRetries, type NormalizedRecallEvaluation } from "../app/lib/v2/recallEvaluation.ts";

export const ANSWER_MODEL = "deepseek/deepseek-v4.1-flash";
export type ExperimentQuestion = {
  id: string;
  userId: string;
  prompt: string;
  referenceAnswer: string;
  lifecycle: "active" | "flagged" | "archived";
};
export type ExperimentResult = {
  question: ExperimentQuestion;
  answer?: string;
  evaluation?: NormalizedRecallEvaluation;
  error?: string;
  elapsedMs: number;
  answerRouting?: "default" | "throughput";
};

// Accept only a string: answer standards and adjacent questions cannot enter this request.
export function answerRequest(prompt: string) {
  return {
    model: ANSWER_MODEL,
    messages: [{ role: "user", content: `Answer the following question:\n\n${prompt}` }],
    temperature: 0,
    reasoning: { enabled: false },
    provider: { require_parameters: true, sort: "throughput" },
    max_tokens: 4096,
  };
}

export async function answerQuestion(prompt: string): Promise<string> {
  const key = resolveOpenRouterApiKey();
  if (!key) throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: buildOpenRouterHeaders(key),
      body: JSON.stringify(answerRequest(prompt)),
      signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      // Retry transient gateway failures, never an unavailable/unauthorized model.
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const seconds = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve,
          Math.min(30_000, seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt)));
        continue;
      }
      await response.body?.cancel();
      throw new Error(`Answer model request failed: HTTP ${response.status}`);
    }
    let body: {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    try {
      body = await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (body.model !== ANSWER_MODEL) throw new Error("Answer model identity mismatch.");
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== "stop" || !choice.message?.content?.trim()) {
      throw new Error(`Answer was empty or incomplete (finish_reason=${choice?.finish_reason ?? "missing"}); not a quality failure.`);
    }
    return choice.message.content.trim();
  }
  throw new Error("Answer request exhausted retries.");
}

export async function runQuestion(
  question: ExperimentQuestion,
  answer: (prompt: string) => Promise<string> = answerQuestion,
  evaluate = (input: Parameters<typeof evaluateRecall>[0]) => evaluateRecall(input),
): Promise<ExperimentResult> {
  const started = Date.now();
  let generated: string | undefined;
  try {
    generated = await answer(question.prompt);
    const evaluation = await evaluateRecallWithRetries({
      prompt: question.prompt,
      evaluate: () => evaluate({
        userId: "question-quality-experiment-no-persist",
        prompt: question.prompt,
        referenceAnswer: question.referenceAnswer,
        answer: generated!,
      }),
    });
    return { question, answer: generated, evaluation, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      question, answer: generated,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

export async function runConcurrent<T>(
  items: readonly T[], concurrency: number, work: (item: T) => Promise<void | boolean>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Concurrency must be an integer from 1 to 16.");
  }
  let next = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const item = items[next++];
      if (await work(item) === false) stopped = true;
    }
  }));
}

export function flagDetail(result: ExperimentResult, runId: string): string | null {
  if (!result.evaluation || result.evaluation.recallResult === "correct" || result.error) return null;
  const detail = [
    `[Question quality experiment ${runId}]`,
    `Suspected question-quality issue: ${ANSWER_MODEL} answered this question alone, without the answer standard or other questions; optional reasoning was disabled.`,
    `Evaluation: ${result.evaluation.recallResult}. This may also reflect an answering-model or evaluator error.`,
    `Evaluator feedback: ${result.evaluation.feedback}`,
    `Scoring issues: ${result.evaluation.scoringIssues.join("; ")}`,
    `Model answer: ${result.answer}`,
  ].join("\n\n");
  return detail.length <= 4000 ? detail : `${detail.slice(0, 3980)}\n[truncated]`;
}
