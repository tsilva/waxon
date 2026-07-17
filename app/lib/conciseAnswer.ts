import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  getOpenRouterChatModel,
  openRouterChatCompletion,
  type OpenRouterTraceContext,
} from "./openRouter";
import {
  buildConciseAnswerRequest,
  parseConciseAnswerResults,
} from "../../shared/concise-answer-contract.mts";

export type ConciseAnswerInput = {
  id: string;
  question: string;
};

export type ConciseAnswerResult = ConciseAnswerInput & {
  conciseAnswer: string;
};

const CONCISE_ANSWER_TIMEOUT_MS = 25_000;

export async function generateConciseAnswers(
  input: ConciseAnswerInput[],
  trace: Partial<OpenRouterTraceContext> = {},
): Promise<ConciseAnswerResult[]> {
  if (input.length === 0) {
    return [];
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
  }

  const model = getOpenRouterChatModel() ?? "";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONCISE_ANSWER_TIMEOUT_MS,
  );

  try {
    const { response, body } = await openRouterChatCompletion({
      apiKey,
      signal: controller.signal,
      trace: {
        operation: trace.operation ?? "concise_answer",
        userId: trace.userId,
        question: trace.question ?? (input.length === 1 ? input[0]?.question : null),
      },
      body: buildConciseAnswerRequest({
        model,
        questions: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Concise answer generation failed (${response.status}).`);
    }

    return parseConciseAnswerResults(input, extractChatCompletionText(body));
  } finally {
    clearTimeout(timeout);
  }
}
