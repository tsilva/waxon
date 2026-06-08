import { extractJsonObject } from "./jsonObject";
import {
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import {
  getRecentQuestionAttempts,
  readQuestions,
  type DeckSummary,
  type QuestionInput,
} from "./postgresStore";
import { getQuestionQualityReference } from "./questionQualityReference";

const DEFAULT_BULK_QUESTION_COUNT = 50;
const MAX_BULK_QUESTION_COUNT = 80;
const MAX_EXISTING_QUESTION_CONTEXT = 240;
const MAX_RECENT_ATTEMPTS = 30;
const MAX_QUESTION_CHARS = 1_200;
const MAX_CONCISE_ANSWER_CHARS = 800;
const MAX_PROVENANCE_CHARS = 360;

type GeneratedQuestionPayload = {
  question: string;
  conciseAnswer: string;
  questionProvenance: string;
};

export function normalizeBulkQuestionCount(value: unknown): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : DEFAULT_BULK_QUESTION_COUNT;

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_BULK_QUESTION_COUNT;
  }

  return Math.min(
    MAX_BULK_QUESTION_COUNT,
    Math.max(1, Math.round(numericValue)),
  );
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function buildGenerationSystemPrompt(questionQualityReference: string): string {
  return [
    "You generate bulk Waxon questions that continue learning when a review rotation has no due questions.",
    "Use the deck MEMORY.md as the durable curriculum state. Do not update or emit memory diffs.",
    "Generate questions from the first useful Frontier Queue and Target Ledger todo/weak/planned targets in learner order.",
    "Earlier questions must support later dependent questions.",
    "Do not generate review, recap, or practice duplicates. Introduce uncovered targets or repair weak/partial targets.",
    "Each question must include a conciseAnswer for semantic dedupe and a questionProvenance explaining why this target is next.",
    "Never reveal the answer in the question text. Do not include numbering or preambles.",
    "Return strict JSON only:",
    '{"questions":[{"question":"...","conciseAnswer":"short expected answer","questionProvenance":"why now"}]}',
    "Shared Waxon question-quality reference:",
    questionQualityReference,
  ].join("\n\n");
}

function normalizeGeneratedQuestions(
  value: unknown,
  count: number,
): GeneratedQuestionPayload[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const questions = (value as { questions?: unknown }).questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: GeneratedQuestionPayload[] = [];

  for (const item of questions) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const question = normalizeText(record.question, MAX_QUESTION_CHARS);
    const conciseAnswer = normalizeText(
      record.conciseAnswer,
      MAX_CONCISE_ANSWER_CHARS,
    );
    const questionProvenance = normalizeText(
      record.questionProvenance ?? record.provenance,
      MAX_PROVENANCE_CHARS,
    );
    const key = question.toLowerCase();

    if (
      !question ||
      !conciseAnswer ||
      !questionProvenance ||
      /\b(review|recap|practice)\b/iu.test(questionProvenance) ||
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      conciseAnswer,
      questionProvenance,
    });
  }

  return normalized.slice(0, count);
}

export async function generateBulkQuestionsFromMemory(input: {
  apiKey: string;
  model: string;
  userId: string;
  deck: DeckSummary;
  memory: string;
  count: number;
}): Promise<{
  model: string;
  questions: QuestionInput[];
}> {
  const existingQuestions = await readQuestions({
    userId: input.userId,
    deckId: input.deck.id,
  });
  const recentAttempts = await getRecentQuestionAttempts({
    userId: input.userId,
    deckId: input.deck.id,
    limit: MAX_RECENT_ATTEMPTS,
  });
  const questionQualityReference = getQuestionQualityReference();
  const { response, body } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    trace: {
      operation: "bulk_generate_questions_from_memory",
      userId: input.userId,
      deckId: input.deck.id,
    },
    body: {
      model: input.model,
      temperature: 0.35,
      max_tokens: Math.min(10_000, 190 * input.count + 1_200),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildGenerationSystemPrompt(questionQualityReference),
        },
        {
          role: "user",
          content: [
            `Generate up to ${input.count} new questions.`,
            "Deck:",
            JSON.stringify({
              name: input.deck.name,
              goal: input.deck.coverage || input.deck.name,
              cardCount: input.deck.cardCount,
              dueCount: input.deck.dueCount,
            }),
            "Current MEMORY.md:",
            input.memory,
            "Existing questions to avoid:",
            JSON.stringify(
              existingQuestions
                .slice(0, MAX_EXISTING_QUESTION_CONTEXT)
                .map((question) => ({
                  question: question.question,
                  conciseAnswer: question.concise_answer,
                  reviews: question.reviews,
                })),
            ),
            "Recent answer attempts:",
            JSON.stringify(recentAttempts),
          ].join("\n\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter bulk generation failed (${response.status}).`);
  }

  const content = extractChatCompletionText(body);

  if (!content) {
    throw new Error("OpenRouter returned no generated content.");
  }

  return {
    model: input.model,
    questions: normalizeGeneratedQuestions(
      extractJsonObject(content),
      input.count,
    ),
  };
}
