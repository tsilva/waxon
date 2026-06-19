import { extractJsonObject } from "./jsonObject";
import {
  extractAffordableOpenRouterMaxTokens,
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import {
  memorySectionBody,
  type KnowledgeSummary,
} from "./knowledgeMemory";
import {
  getRecentQuestionAttempts,
  readQuestions,
  type QuestionInput,
} from "./postgresStore";
import { getQuestionQualityReference } from "./questionQualityReference";
import { extractCompleteJsonObjectsFromArrayProperty } from "./streamedJsonArray";

const DEFAULT_BULK_QUESTION_COUNT = 50;
const MAX_BULK_QUESTION_COUNT = 80;
const MAX_EXISTING_QUESTION_CONTEXT = 160;
const MAX_RECENT_ATTEMPTS = 30;
const MAX_QUESTION_CHARS = 1_200;
const MAX_CONCISE_ANSWER_CHARS = 800;
const MAX_PROVENANCE_CHARS = 360;
const MAX_BULK_COMPLETION_TOKENS = 10_000;
const MIN_BULK_RETRY_COMPLETION_TOKENS = 1_000;

export type GeneratedQuestionPayload = {
  question: string;
  conciseAnswer: string;
  questionProvenance: string;
  proposedConceptSlugs?: string[];
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

function buildGenerationMemoryContext(memory: string): string {
  const sections = [
    "Goal",
    "Target Ledger",
    "Weak Points",
    "Frontier",
    "Frontier Queue",
    "Completion",
  ]
    .map((heading) => {
      const body = memorySectionBody(memory, heading);

      return body ? `## ${heading}\n${body}` : "";
    })
    .filter(Boolean);

  return sections.length > 0 ? sections.join("\n\n") : memory;
}

function buildGenerationSystemPrompt(questionQualityReference: string): string {
  return [
    "You generate bulk learning questions that continue learning when a review rotation has no due questions.",
    "Use the memory excerpts as durable curriculum state. Generate from the first useful Frontier Queue and Target Ledger todo/weak/planned targets in learner order.",
    "Earlier questions must support later dependent questions. Introduce uncovered targets or repair weak/partial targets; no review, recap, or practice duplicates.",
    "Never reveal the answer in the question text. Return compact keys: q=question, a=concise expected answer, p=why this target is next, c=concept slug.",
    "The c value must be one full self-disambiguating lowercase kebab-case concept slug, not an acronym-only tag.",
    "Return strict JSON only:",
    '{"questions":[{"q":"...","a":"short expected answer","p":"why now","c":"concept-slug"}]}',
    "Shared question-quality reference:",
    questionQualityReference,
  ].join("\n\n");
}

export function normalizeGeneratedQuestions(
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
    const question = normalizeText(record.question ?? record.q, MAX_QUESTION_CHARS);
    const conciseAnswer = normalizeText(
      record.conciseAnswer ?? record.a,
      MAX_CONCISE_ANSWER_CHARS,
    );
    const questionProvenance = normalizeText(
      record.questionProvenance ?? record.provenance ?? record.p,
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
      proposedConceptSlugs: [normalizeText(record.conceptSlug ?? record.c, 120)]
        .filter(Boolean),
    });
  }

  return normalized.slice(0, count);
}

export function normalizePartialGeneratedQuestions(
  text: string,
  count: number,
): GeneratedQuestionPayload[] {
  return normalizeGeneratedQuestions(
    {
      questions: extractCompleteJsonObjectsFromArrayProperty(text, "questions"),
    },
    count,
  );
}

function getBulkCompletionTokenLimit(count: number): number {
  return Math.min(MAX_BULK_COMPLETION_TOKENS, 190 * count + 1_200);
}

export async function generateBulkQuestionsFromMemory(input: {
  apiKey: string;
  model: string;
  userId: string;
  knowledgeBase: KnowledgeSummary;
  memory: string;
  count: number;
  onPartialQuestions?: (questions: GeneratedQuestionPayload[]) => void;
}): Promise<{
  model: string;
  questions: QuestionInput[];
}> {
  const existingQuestions = await readQuestions({ userId: input.userId });
  const recentAttempts = await getRecentQuestionAttempts({
    userId: input.userId,
    limit: MAX_RECENT_ATTEMPTS,
  });
  const questionQualityReference = getQuestionQualityReference();
  let streamedContent = "";
  let partialQuestionCount = 0;
  const onTextDelta = (delta: string) => {
    streamedContent += delta;

    if (!input.onPartialQuestions) {
      return;
    }

    const partialQuestions = normalizePartialGeneratedQuestions(
      streamedContent,
      input.count,
    );

    if (partialQuestions.length > partialQuestionCount) {
      partialQuestionCount = partialQuestions.length;
      input.onPartialQuestions(partialQuestions);
    }
  };
  const trace = {
    operation: "bulk_generate_questions_from_memory",
    userId: input.userId,
  };
  const requestBody = {
    model: input.model,
    temperature: 0.35,
    max_tokens: getBulkCompletionTokenLimit(input.count),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system" as const,
        content: buildGenerationSystemPrompt(questionQualityReference),
      },
      {
        role: "user" as const,
        content: [
          `Generate up to ${input.count} new questions.`,
          "Knowledge base:",
          JSON.stringify({
            name: input.knowledgeBase.name,
            goal: input.knowledgeBase.goal,
            cardCount: input.knowledgeBase.cardCount,
            dueCount: input.knowledgeBase.dueCount,
          }),
          "Memory excerpts:",
          buildGenerationMemoryContext(input.memory),
          "Existing questions to avoid:",
          JSON.stringify(
            existingQuestions
              .slice(0, MAX_EXISTING_QUESTION_CONTEXT)
              .map((question) => ({
                q: question.question,
                a: question.concise_answer,
              })),
          ),
          "Recent answer attempts:",
          JSON.stringify(
            recentAttempts.map((attempt) => ({
              q: attempt.question,
              answer: attempt.answerSummary || attempt.rawAnswer,
              score: attempt.score,
            })),
          ),
        ].join("\n\n"),
      },
    ],
  };
  let completion = await openRouterChatCompletion({
    apiKey: input.apiKey,
    trace,
    body: requestBody,
    onTextDelta,
  });

  if (!completion.response.ok) {
    const affordableMaxTokens = extractAffordableOpenRouterMaxTokens(
      completion.body,
    );

    if (
      completion.response.status === 402 &&
      affordableMaxTokens !== null &&
      affordableMaxTokens >= MIN_BULK_RETRY_COMPLETION_TOKENS &&
      affordableMaxTokens < requestBody.max_tokens
    ) {
      streamedContent = "";
      partialQuestionCount = 0;
      completion = await openRouterChatCompletion({
        apiKey: input.apiKey,
        trace,
        body: {
          ...requestBody,
          max_tokens: affordableMaxTokens,
        },
        onTextDelta,
      });
    }
  }

  if (!completion.response.ok) {
    throw new Error(
      `OpenRouter bulk generation failed (${completion.response.status}).`,
    );
  }

  const content = extractChatCompletionText(completion.body);

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
