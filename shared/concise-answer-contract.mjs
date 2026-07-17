import { extractJsonObject } from "./json-object.mjs";
import {
  loadPromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates.mjs";

export const MAX_CONCISE_ANSWER_CHARS = 320;

const CONCISE_ANSWER_SYSTEM_PROMPT = loadPromptTemplate(
  "concise-answer-system.md",
);

export function buildConciseAnswerRequest({ model, questions }) {
  return {
    model,
    response_format: { type: "json_object" },
    temperature: 0,
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

export function parseConciseAnswerResults(questions, responseText) {
  const parsed = extractJsonObject(responseText);

  if (!Array.isArray(parsed.answers)) {
    throw new Error("Concise answer generation returned no answers.");
  }

  const answersById = new Map();

  for (const item of parsed.answers) {
    const id = String(item?.id ?? "").trim();
    const conciseAnswer =
      typeof item?.conciseAnswer === "string"
        ? item.conciseAnswer
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
