export type ReferenceAnswerInput = {
  question: string;
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

export async function generateReferenceAnswer(
  input: ReferenceAnswerInput,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;

  if (!apiKey) {
    return "Reference answer is unavailable because no LLM API key is configured.";
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REFERENCE_ANSWER_TIMEOUT_MS,
  );

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
        temperature: 0,
        max_tokens: 420,
      }),
    });

    if (!response.ok) {
      return "Reference answer is unavailable right now.";
    }

    const answer = extractChatCompletionText(await response.json());
    return answer || "Reference answer is unavailable right now.";
  } catch {
    return "Reference answer is unavailable right now.";
  } finally {
    clearTimeout(timeout);
  }
}
