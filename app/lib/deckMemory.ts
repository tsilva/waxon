import { extractJsonObject } from "./jsonObject";
import {
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import {
  getRecentQuestionAttempts,
  listDecks,
  readQuestions,
  updateDeck,
  type DeckSummary,
} from "./postgresStore";

const MAX_DECK_MEMORY_CHARS = 8_000;
const MAX_MEMORY_CONTEXT_QUESTIONS = 220;
const MAX_MEMORY_CONTEXT_ATTEMPTS = 40;

type DeckMemoryRefreshReason =
  | "before_generation"
  | "after_answer_batch"
  | "cron"
  | "manual";

type DeckMemoryQuestionContext = {
  question: string;
  conciseAnswer: string;
  reviews: string;
  questionProvenance: string;
};

function normalizeMarkdownText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, maxLength)
    : "";
}

export function initialDeckMemory(deck: { name: string; goal: string }): string {
  return [
    "# Deck Memory",
    "",
    "## Goal",
    `${deck.goal || deck.name}`,
    "",
    "## Curriculum Map",
    "- Status: not yet inferred.",
    "- Scope: infer from the deck goal, then keep this section compact.",
    "",
    "## Target Ledger",
    "- Status: not yet inferred.",
    "- Use one line per atomic target when feasible, or compact ordered modules for large/open goals.",
    "- Status labels: todo, planned, strong, partial, weak.",
    "",
    "## Proficiency",
    "- No answered questions yet.",
    "",
    "## Weak Points",
    "- None observed yet.",
    "",
    "## Frontier",
    "- Start with the simplest prerequisite recall targets.",
    "",
    "## Frontier Queue",
    "- Infer the ordered uncovered target queue from the goal before generating.",
    "",
    "## Completion",
    "- Not complete.",
  ].join("\n");
}

export function normalizeDeckMemory(
  memory: string,
  deck: { name: string; goal: string },
): string {
  const source = memory.trim() || initialDeckMemory(deck);

  return source.slice(0, MAX_DECK_MEMORY_CHARS);
}

function buildDeckMemorySystemPrompt(): string {
  return [
    "You update Waxon deck MEMORY.md files.",
    "The memory is a durable deck-level curriculum asset, not a question-generation response.",
    "Infer the current learning state from the deck goal, current memory, existing questions, and recent answer attempts.",
    "Preserve established scope unless the deck goal clearly requires expanding it. Never narrow a broad or complete goal into only a beginner subset.",
    "Maintain compact sections: Goal, Curriculum Map, Target Ledger, Proficiency, Weak Points, Frontier, Frontier Queue, Completion.",
    "Use Target Ledger statuses: todo, planned, strong, partial, weak.",
    "Mark answered high-score targets strong, low-score targets weak or partial, generated unanswered targets planned, and future uncovered targets todo.",
    "For finite goals, make the Target Ledger or module map explicit enough that completion is auditable.",
    "Preserve exact symbols, formulas, code identifiers, names, terms, kana, and other atomic target strings.",
    "Return strict JSON only: {\"memory\":\"# Deck Memory\\n...\"}",
  ].join("\n\n");
}

function compactQuestionContext(
  questions: DeckMemoryQuestionContext[],
): DeckMemoryQuestionContext[] {
  return questions.slice(0, MAX_MEMORY_CONTEXT_QUESTIONS);
}

export async function refreshDeckMemory(input: {
  apiKey: string;
  model: string;
  userId: string;
  deckId: string;
  reason: DeckMemoryRefreshReason;
}): Promise<{
  deck: DeckSummary;
  memory: string;
  updated: boolean;
}> {
  const deck = (await listDecks({ userId: input.userId })).find(
    (candidate) => candidate.id === input.deckId,
  );

  if (!deck) {
    throw new Error("Deck not found.");
  }

  const deckGoal = deck.coverage || deck.name;
  const currentMemory = normalizeDeckMemory(deck.memory, {
    name: deck.name,
    goal: deckGoal,
  });
  const questions = await readQuestions({
    userId: input.userId,
    deckId: deck.id,
  });
  const recentAttempts = await getRecentQuestionAttempts({
    userId: input.userId,
    deckId: deck.id,
    limit: MAX_MEMORY_CONTEXT_ATTEMPTS,
  });
  const questionContext = compactQuestionContext(
    questions.map((question) => ({
      question: question.question,
      conciseAnswer: question.concise_answer,
      reviews: question.reviews,
      questionProvenance: question.question_provenance,
    })),
  );

  const { response, body } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    trace: {
      operation: "refresh_deck_memory",
      userId: input.userId,
      deckId: deck.id,
    },
    body: {
      model: input.model,
      temperature: 0.2,
      max_tokens: 5_000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildDeckMemorySystemPrompt(),
        },
        {
          role: "user",
          content: [
            `Refresh reason: ${input.reason}.`,
            "Deck:",
            JSON.stringify({
              name: deck.name,
              goal: deckGoal,
              cardCount: deck.cardCount,
              dueCount: deck.dueCount,
            }),
            "Current MEMORY.md:",
            currentMemory,
            "Existing deck questions:",
            JSON.stringify(questionContext),
            "Recent answer attempts:",
            JSON.stringify(recentAttempts),
          ].join("\n\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    return {
      deck,
      memory: currentMemory,
      updated: false,
    };
  }

  const content = extractChatCompletionText(body);
  let parsed: { memory?: unknown };

  try {
    parsed = extractJsonObject(content) as { memory?: unknown };
  } catch {
    return {
      deck,
      memory: currentMemory,
      updated: false,
    };
  }

  const nextMemory = normalizeMarkdownText(
    parsed.memory,
    MAX_DECK_MEMORY_CHARS,
  );

  if (!nextMemory || nextMemory === deck.memory.trim()) {
    return {
      deck,
      memory: nextMemory || currentMemory,
      updated: false,
    };
  }

  const updatedDeck = await updateDeck({
    userId: input.userId,
    deckId: deck.id,
    memory: nextMemory,
  });

  return {
    deck: updatedDeck,
    memory: nextMemory,
    updated: true,
  };
}
