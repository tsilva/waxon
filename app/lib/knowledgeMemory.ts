import { extractJsonObject } from "./jsonObject";
import {
  extractChatCompletionText,
  openRouterChatCompletion,
} from "./openRouter";
import {
  getRecentQuestionAttempts,
  readQuestions,
} from "./postgresStore";

export const MAX_KNOWLEDGE_MEMORY_CHARS = 8_000;
const MAX_MEMORY_CONTEXT_QUESTIONS = 220;
const MAX_MEMORY_CONTEXT_ATTEMPTS = 40;

type KnowledgeMemoryRefreshReason =
  | "before_generation"
  | "after_answer_batch"
  | "cron"
  | "manual";

type KnowledgeMemoryQuestionContext = {
  question: string;
  conciseAnswer: string;
  reviews: string;
  questionProvenance: string;
};

export type KnowledgeSummary = {
  name: string;
  goal: string;
  cardCount: number;
  dueCount: number;
};

export function normalizeMarkdownText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, maxLength)
    : "";
}

function escapeMarkdownHeading(heading: string): string {
  return heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function initialKnowledgeMemory(input: { name: string; goal: string }): string {
  return [
    "# Knowledge Memory",
    "",
    "## Goal",
    `${input.goal || input.name}`,
    "",
    "## Curriculum Map",
    "- Status: not yet inferred.",
    "- Scope: infer from the user's active knowledge base, then keep this section compact.",
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

export function normalizeKnowledgeMemory(
  memory: string,
  input: { name: string; goal: string },
): string {
  const source = memory.trim() || initialKnowledgeMemory(input);

  return source.slice(0, MAX_KNOWLEDGE_MEMORY_CHARS);
}

export function memorySectionBody(memory: string, heading: string): string {
  const escapedHeading = escapeMarkdownHeading(heading);
  const match = memory.match(
    new RegExp(
      `^##\\s+${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
      "imu",
    ),
  );

  return match?.[1]?.trim() ?? "";
}

function buildKnowledgeMemorySystemPrompt(): string {
  return [
    "You update knowledge MEMORY.md files.",
    "The memory is a durable user-level curriculum asset, not a question-generation response.",
    "Infer the current learning state from the knowledge-base goal, current memory, existing questions, and recent answer attempts.",
    "Preserve established scope unless the knowledge-base goal clearly requires expanding it. Never narrow a broad or complete goal into only a beginner subset.",
    "Maintain compact sections: Goal, Curriculum Map, Target Ledger, Proficiency, Weak Points, Frontier, Frontier Queue, Completion.",
    "Use Target Ledger statuses: todo, planned, strong, partial, weak.",
    "Mark answered high-score targets strong, low-score targets weak or partial, generated unanswered targets planned, and future uncovered targets todo.",
    "For finite goals, make the Target Ledger or module map explicit enough that completion is auditable.",
    "Preserve exact symbols, formulas, code identifiers, names, terms, kana, and other atomic target strings.",
    "Return strict JSON only: {\"memory\":\"# Knowledge Memory\\n...\"}",
  ].join("\n\n");
}

function compactQuestionContext(
  questions: KnowledgeMemoryQuestionContext[],
): KnowledgeMemoryQuestionContext[] {
  return questions.slice(0, MAX_MEMORY_CONTEXT_QUESTIONS);
}

export async function refreshKnowledgeMemory(input: {
  apiKey: string;
  model: string;
  userId: string;
  reason: KnowledgeMemoryRefreshReason;
}): Promise<{
  knowledgeBase: KnowledgeSummary;
  memory: string;
  updated: boolean;
}> {
  const knowledgeBase: KnowledgeSummary = {
    name: "Knowledge base",
    goal: "Continue expanding and maintaining the user's knowledge base.",
    cardCount: 0,
    dueCount: 0,
  };
  const currentMemory = normalizeKnowledgeMemory("", knowledgeBase);
  const questions = await readQuestions({ userId: input.userId });
  const recentAttempts = await getRecentQuestionAttempts({
    userId: input.userId,
    limit: MAX_MEMORY_CONTEXT_ATTEMPTS,
  });
  knowledgeBase.cardCount = questions.length;
  knowledgeBase.dueCount = questions.filter(
    (question) => question.flagged_at === null && question.next_due <= Date.now(),
  ).length;
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
      operation: "refresh_knowledge_memory",
      userId: input.userId,
    },
    body: {
      model: input.model,
      temperature: 0.2,
      max_tokens: 5_000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildKnowledgeMemorySystemPrompt(),
        },
        {
          role: "user",
          content: [
            `Refresh reason: ${input.reason}.`,
            "Knowledge base:",
            JSON.stringify({
              name: knowledgeBase.name,
              goal: knowledgeBase.goal,
              cardCount: knowledgeBase.cardCount,
              dueCount: knowledgeBase.dueCount,
            }),
            "Current MEMORY.md:",
            currentMemory,
            "Existing knowledge-base questions:",
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
      knowledgeBase,
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
      knowledgeBase,
      memory: currentMemory,
      updated: false,
    };
  }

  const nextMemory = normalizeMarkdownText(
    parsed.memory,
    MAX_KNOWLEDGE_MEMORY_CHARS,
  );

  if (!nextMemory || nextMemory === currentMemory) {
    return {
      knowledgeBase,
      memory: nextMemory || currentMemory,
      updated: false,
    };
  }

  return {
    knowledgeBase,
    memory: nextMemory,
    updated: false,
  };
}
