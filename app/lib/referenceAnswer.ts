import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
} from "./openRouter";

export type ReferenceAnswerInput = {
  question: string;
  userId?: string | null;
  deckId?: string | null;
};

const REFERENCE_ANSWER_TIMEOUT_MS = 25_000;
const REFERENCE_ANSWER_EXPLANATION_PATTERN =
  /(^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Why(?:\*\*)?\s*:/i;

export function hasReferenceAnswerExplanation(answer: string): boolean {
  return REFERENCE_ANSWER_EXPLANATION_PATTERN.test(answer);
}

function buildPrompt(input: ReferenceAnswerInput): string {
  return `Answer this flashcard as a concise reference answer with a brief explanation.

Question: ${input.question}

Return both sections using exactly these Markdown labels:
- **Answer:** the direct answer.
- **Why:** a brief explanation of why the answer is correct.

Keep the total response direct, accurate, and no longer than five sentences.
Use Markdown when it improves readability. Use inline math as $...$ and display equations as $$...$$.`;
}

export async function generateReferenceAnswer(
  input: ReferenceAnswerInput,
): Promise<string> {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return "Reference answer is unavailable because no LLM API key is configured.";
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REFERENCE_ANSWER_TIMEOUT_MS,
  );

  try {
    const { response, body } = await openRouterChatCompletion({
      apiKey,
      signal: controller.signal,
      trace: {
        operation: "reference_answer",
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
        temperature: 0,
        max_tokens: 420,
      },
    });

    if (!response.ok) {
      return "Reference answer is unavailable right now.";
    }

    const answer = extractChatCompletionText(body);
    return answer || "Reference answer is unavailable right now.";
  } catch {
    return "Reference answer is unavailable right now.";
  } finally {
    clearTimeout(timeout);
  }
}
