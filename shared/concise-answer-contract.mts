import { extractJsonObject } from "./json-object.mts";
import {
  loadPromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates.mts";

export const MAX_CONCISE_ANSWER_CHARS = 320;

export type ConciseAnswerQuestion = {
  id: string;
  question: string;
};

export type ConciseAnswerResult = ConciseAnswerQuestion & {
  conciseAnswer: string;
};

type ConciseAnswerResponse = {
  answers?: unknown;
};

const CONCISE_ANSWER_SYSTEM_PROMPT = loadPromptTemplate(
  "concise-answer-system.md",
);

export function buildConciseAnswerRequest({
  model,
  questions,
}: {
  model: string;
  questions: ConciseAnswerQuestion[];
}): {
  model: string;
  response_format: { type: "json_object" };
  max_tokens: number;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
} {
  return {
    model,
    response_format: { type: "json_object" },
    max_tokens: Math.min(4096, 140 * questions.length + 400),
    messages: [
      {
        role: "system",
        content: CONCISE_ANSWER_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: renderPromptTemplate(
          loadPromptTemplate("concise-answer-user.md"),
          {
            questionsJson: JSON.stringify(
              questions.map((item) => ({
                id: item.id,
                question: item.question,
              })),
            ),
          },
        ),
      },
    ],
  };
}

export function parseConciseAnswerResults(
  questions: ConciseAnswerQuestion[],
  responseText: string,
): ConciseAnswerResult[] {
  const parsed = extractJsonObject(responseText) as ConciseAnswerResponse;

  if (!Array.isArray(parsed.answers)) {
    throw new Error("Concise answer generation returned no answers.");
  }

  const answersById = new Map<string, string>();

  for (const item of parsed.answers) {
    const candidate = item as
      | { id?: unknown; conciseAnswer?: unknown }
      | null
      | undefined;
    const id = String(candidate?.id ?? "").trim();
    const conciseAnswer =
      typeof candidate?.conciseAnswer === "string"
        ? candidate.conciseAnswer
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, MAX_CONCISE_ANSWER_CHARS)
        : "";

    if (id && conciseAnswer) {
      answersById.set(id, conciseAnswer);
    }
  }

  return questions.map((item) => ({
    ...item,
    conciseAnswer: answersById.get(item.id) ?? "",
  }));
}
