import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  getOpenRouterChatModel,
  openRouterChatCompletion,
  type OpenRouterTraceContext,
} from "./openRouter";
import { extractJsonObject } from "./jsonObject";

export type ConciseAnswerInput = {
  id: string;
  question: string;
};

export type ConciseAnswerResult = ConciseAnswerInput & {
  conciseAnswer: string;
};

const CONCISE_ANSWER_TIMEOUT_MS = 25_000;
const MAX_CONCISE_ANSWER_CHARS = 320;
const CONCISE_ANSWER_SYSTEM_PROMPT = [
  "Generate concise expected answers for flashcard questions.",
  "Each answer is used for semantic duplicate detection, not as an explanation.",
  "Keep each answer factual, direct, and as short as possible while preserving the recall target.",
  "Return strict JSON: {\"answers\":[{\"id\":\"...\",\"conciseAnswer\":\"...\"}]}",
].join("\n\n");

function normalizeConciseAnswer(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, MAX_CONCISE_ANSWER_CHARS);
}

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
      body: {
        model,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: Math.min(4096, 140 * input.length + 400),
        messages: [
          {
            role: "system",
            content: CONCISE_ANSWER_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              "Questions:",
              JSON.stringify(
                input.map((item) => ({
                  id: item.id,
                  question: item.question,
                })),
              ),
            ].join("\n\n"),
          },
        ],
      },
    });

    if (!response.ok) {
      throw new Error(`Concise answer generation failed (${response.status}).`);
    }

    const raw = extractChatCompletionText(body);
    const parsed = extractJsonObject(raw) as { answers?: unknown };

    if (!Array.isArray(parsed.answers)) {
      throw new Error("Concise answer generation returned no answers.");
    }

    const answersById = new Map<string, string>();

    for (const item of parsed.answers) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const conciseAnswer = normalizeConciseAnswer(record.conciseAnswer);

      if (id && conciseAnswer) {
        answersById.set(id, conciseAnswer);
      }
    }

    return input.map((item) => ({
      ...item,
      conciseAnswer: answersById.get(item.id) ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}
