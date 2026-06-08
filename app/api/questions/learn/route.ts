import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { extractJsonObject } from "@/app/lib/jsonObject";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
} from "@/app/lib/openRouter";
import {
  ensureQuestionsDatabase,
  getRecentQuestionAttempts,
  listDecks,
  resolveOwnedDeckId,
  updateDeck,
  type DeckSummary,
  type QuestionInput,
} from "@/app/lib/postgresStore";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_MODEL = process.env.LLM_MODEL?.trim() ?? "";
const LEARN_BATCH_SIZE = 20;
const MAX_LEARN_BODY_BYTES = 48 * 1024;
const MAX_DECK_ID_CHARS = 200;
const MAX_QUESTION_CHARS = 1_200;
const MAX_ANSWER_CHARS = 2_000;
const MAX_JUSTIFICATION_CHARS = 2_000;
const MAX_PREVIOUS_ANSWERS = 20;
const MAX_PROVENANCE_CHARS = 360;
const MAX_DECK_MEMORY_CHARS = 8_000;
const MAX_MEMORY_SECTION_CHARS = 5_000;
const MAX_MEMORY_HEADING_CHARS = 80;
const LEARN_GENERATION_MAX_TOKENS = Number.parseInt(
  process.env.LEARN_GENERATION_MAX_TOKENS ?? "6000",
  10,
);
const LEARN_REASONING_MAX_TOKENS = Number.parseInt(
  process.env.LEARN_REASONING_MAX_TOKENS ?? "256",
  10,
);

type PreviousAnswerContext = {
  question: string;
  answer: string;
  score: number | null;
  justification: string;
};

type LearnQuestionPayload = {
  question: string;
  conciseAnswer: string;
  questionProvenance: string;
};

type LearnCompletionResult = {
  model: string;
  body: unknown;
  json: unknown;
};

type LearnMemoryPatch =
  | {
      op: "replace_section";
      heading: string;
      body: string;
    }
  | {
      op: "append_note";
      heading: string;
      text: string;
    };

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

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

function normalizePreviousAnswers(value: unknown): PreviousAnswerContext[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: PreviousAnswerContext[] = [];

  for (const item of value.slice(0, MAX_PREVIOUS_ANSWERS)) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const question = normalizeText(record.question, MAX_QUESTION_CHARS);
    const answer = normalizeText(record.answer, MAX_ANSWER_CHARS);
    const numericScore =
      typeof record.score === "number" && Number.isFinite(record.score)
        ? Math.round(record.score)
        : null;

    if (!question || !answer) {
      continue;
    }

    normalized.push({
      question,
      answer,
      score:
        numericScore === null ? null : Math.min(10, Math.max(0, numericScore)),
      justification: normalizeText(record.justification, MAX_JUSTIFICATION_CHARS),
    });
  }

  return normalized;
}

function normalizeQuestionCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return LEARN_BATCH_SIZE;
  }

  return Math.min(LEARN_BATCH_SIZE, Math.max(LEARN_BATCH_SIZE, Math.floor(value)));
}

function normalizeGeneratedQuestions(
  value: unknown,
  questionCount: number,
): LearnQuestionPayload[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const questions = (value as { questions?: unknown }).questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: LearnQuestionPayload[] = [];

  for (const item of questions) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const question = normalizeText(record.question, MAX_QUESTION_CHARS);
    const conciseAnswer = normalizeText(record.conciseAnswer, 800);
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

  return normalized.slice(0, questionCount);
}

function normalizeAuditComplete(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (value as { complete?: unknown }).complete === true;
}

function buildQuestionQualitySummary(questionQualityReference: string): string {
  const criteria = [
    "Concise",
    "Single-target",
    "Self-describing",
    "Standalone",
    "Recall-oriented",
    "Precise",
    "Readable",
    "Non-fragmentary",
  ].filter((criterion) => questionQualityReference.includes(criterion));

  return [
    `Question quality rules: ${criteria.join(", ")}.`,
    "Ask one atomic recall target, include enough context, avoid hints and broad survey prompts.",
  ].join(" ");
}

function buildQuestionQualityPromptBlock(questionQualityReference: string): string {
  return [
    buildQuestionQualitySummary(questionQualityReference),
    "Every generated question must follow the shared Waxon question-quality reference below.",
    "Shared Waxon question-quality reference:",
    questionQualityReference,
  ].join("\n\n");
}

function initialDeckMemory(deck: { name: string; goal: string }): string {
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

function normalizeDeckMemory(memory: string, deck: { name: string; goal: string }): string {
  const source = memory.trim() || initialDeckMemory(deck);

  return source.slice(0, MAX_DECK_MEMORY_CHARS);
}

function normalizeMemoryPatch(value: unknown): LearnMemoryPatch[] {
  const patch = value && typeof value === "object"
    ? (value as { memoryPatch?: unknown }).memoryPatch
    : null;

  if (!Array.isArray(patch)) {
    return [];
  }

  return patch
    .map((item): LearnMemoryPatch | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const op = record.op;
      const heading = normalizeText(record.heading, MAX_MEMORY_HEADING_CHARS)
        .replace(/^#+\s*/u, "");

      if (!heading) {
        return null;
      }

      if (op === "replace_section") {
        const body = normalizeMarkdownText(record.body, MAX_MEMORY_SECTION_CHARS);

        return body ? { op, heading, body } : null;
      }

      if (op === "append_note") {
        const text = normalizeMarkdownText(record.text, MAX_MEMORY_SECTION_CHARS);

        return text ? { op, heading, text } : null;
      }

      return null;
    })
    .filter((item): item is LearnMemoryPatch => item !== null)
    .slice(0, 8);
}

function replaceMemorySection(memory: string, heading: string, body: string): string {
  const sectionHeading = `## ${heading}`;
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(
    `(^##\\s+${escapedHeading}\\s*$)[\\s\\S]*?(?=^##\\s+|(?![\\s\\S]))`,
    "imu",
  );
  const replacement = `${sectionHeading}\n${body.trim()}\n\n`;

  if (sectionPattern.test(memory)) {
    return memory.replace(sectionPattern, replacement);
  }

  return `${memory.trim()}\n\n${replacement}`;
}

function appendMemoryNote(memory: string, heading: string, text: string): string {
  const currentSection = memory.match(
    new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "imu"),
  );

  if (!currentSection) {
    return replaceMemorySection(memory, heading, `- ${text.trim()}`);
  }

  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(
    `(^##\\s+${escapedHeading}\\s*$[\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "imu",
  );

  return memory.replace(sectionPattern, (section) => `${section.trim()}\n- ${text.trim()}\n\n`);
}

function memorySectionBody(memory: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = memory.match(
    new RegExp(`^##\\s+${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "imu"),
  );

  return match?.[1]?.trim() ?? "";
}

function normalizedMemorySectionLines(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/u, "").trim())
    .filter(Boolean);
}

function canApplyMemoryOperation(
  memory: string,
  operation: LearnMemoryPatch,
  input: { hasGeneratedQuestions: boolean },
): boolean {
  const heading = operation.heading.trim().toLowerCase();

  if (heading === "goal") {
    return false;
  }

  if (heading === "curriculum map") {
    const current = memorySectionBody(memory, "Curriculum Map").toLowerCase();

    return !current || current.includes("not yet inferred");
  }

  if (
    heading === "completion" &&
    input.hasGeneratedQuestions &&
    operation.op === "replace_section" &&
    /\bcomplete\b/iu.test(operation.body) &&
    !/\bnot complete\b/iu.test(operation.body)
  ) {
    return false;
  }

  return true;
}

function dedupeMemorySections(memory: string): string {
  const parts = memory.split(/(?=^##\s+)/gim);
  const [preamble = "", ...sections] = parts;
  const seen = new Set<string>();
  const keptSections: string[] = [];

  for (const section of sections) {
    const heading = section.match(/^##\s+(.+?)\s*$/im)?.[1]?.trim().toLowerCase();

    if (!heading) {
      keptSections.push(section.trim());
      continue;
    }

    if (seen.has(heading)) {
      continue;
    }

    seen.add(heading);
    keptSections.push(section.trim());
  }

  return [preamble.trim(), ...keptSections].filter(Boolean).join("\n\n");
}

function applyMemoryPatch(
  memory: string,
  patch: LearnMemoryPatch[],
  input: { hasGeneratedQuestions: boolean },
): string {
  let nextMemory = memory;

  for (const operation of patch) {
    if (!canApplyMemoryOperation(nextMemory, operation, input)) {
      continue;
    }

    if (operation.op === "replace_section") {
      nextMemory = replaceMemorySection(nextMemory, operation.heading, operation.body);
    } else {
      nextMemory = appendMemoryNote(nextMemory, operation.heading, operation.text);
    }
  }

  return dedupeMemorySections(nextMemory).trim().slice(0, MAX_DECK_MEMORY_CHARS);
}

function memoryHasPendingCoverage(memory: string): boolean {
  const completion = memorySectionBody(memory, "Completion").toLowerCase();
  const proficiency = memorySectionBody(memory, "Proficiency").toLowerCase();
  const targetLedger = memorySectionBody(memory, "Target Ledger").toLowerCase();
  const frontierQueue = memorySectionBody(memory, "Frontier Queue").toLowerCase();
  const completionIsComplete =
    /\bcomplete\b/u.test(completion) && !/\bnot complete\b/u.test(completion);
  const targetLedgerLines = normalizedMemorySectionLines(targetLedger).filter(
    (line) =>
      !/^status labels?:/u.test(line) &&
      !/^use one line per atomic target/u.test(line),
  );
  const targetLedgerIsResolved =
    targetLedgerLines.length > 0 &&
    targetLedgerLines.every((line) => !/\bnot yet inferred\b/u.test(line));
  const hasPendingLedger = targetLedgerLines.some((line) =>
    /(?:^|:\s*|\b)(todo|planned|partial|weak|pending|await|awaiting)\b/u.test(line),
  );
  const frontierQueueItems = normalizedMemorySectionLines(frontierQueue);
  const hasConcreteFrontierQueue = frontierQueueItems.some((line) => {
    return (
      line &&
      !/\b(none|empty|complete|completed|no remaining|not yet inferred)\b/u.test(
        line,
      )
    );
  });

  if (targetLedgerIsResolved && !hasPendingLedger) {
    return false;
  }

  return /\b(pending|planned|await|awaiting|not yet scored|not complete)\b/u.test(
    `${completion}\n${proficiency}`,
  ) ||
    hasPendingLedger ||
    (hasConcreteFrontierQueue && !completionIsComplete);
}

function completeLearnMemory(memory: string): string {
  const completedTargetCount = normalizedMemorySectionLines(
    memorySectionBody(memory, "Target Ledger"),
  ).filter(
    (line) =>
      line &&
      !/^status labels?:/u.test(line) &&
      !/^use one line per atomic target/u.test(line) &&
      !/\bnot yet inferred\b/u.test(line),
  ).length;
  const curriculumBody =
    completedTargetCount > 0
      ? `- Complete for the stated goal based on ${completedTargetCount} strong Target Ledger entries.`
      : "- Complete for the stated goal.";

  return replaceMemorySection(
    replaceMemorySection(
      replaceMemorySection(
        replaceMemorySection(memory, "Curriculum Map", curriculumBody),
        "Frontier",
        "- None.",
      ),
      "Frontier Queue",
      "- None.",
    ),
    "Completion",
    "- Complete. No novel uncovered targets remain after audit and dedupe.",
  );
}

function buildLearnSystemPrompt(questionQualityReference: string): string {
  return [
    "You are Waxon's generic deck-memory learn planner. The deck memory is the durable curriculum state; update it and generate the next ordered batch from it.",
    "Do not rely on hardcoded curricula. Infer scope, prerequisites, covered targets, weak points, and frontier from the deck goal, memory, and recent performance.",
    "Never narrow an established Curriculum Map or Target Ledger. You may expand or clarify them, but do not replace a complete/all/entire goal with a smaller starter subset.",
    "The ## Target Ledger is the source of truth. Maintain it as ordered target coverage with statuses: todo, planned, strong, partial, weak. For finite goals, infer the full target set or full module set before declaring completion. For broad goals, keep expandable modules and a concrete next frontier.",
    "Curriculum Map must summarize the full Target Ledger. If the ledger contains targets outside the map, expand the map; do not leave them inconsistent.",
    "Preserve target text exactly in memory for symbols, formulas, code identifiers, names, terms, or other atomic targets. Copy exact target strings from generated questions and answered performance; do not transliterate, normalize, substitute, or retype similar-looking characters.",
    `Generate up to ${LEARN_BATCH_SIZE} new questions in learner order. Earlier questions must support later dependent questions.`,
    "The ## Frontier Queue section is canonical for the next batch. Generate questions for the first todo queue items in exact queue order. Never skip a queue item to ask a later target. If the queue is missing, reconstruct it in memoryPatch before using it.",
    "Targets described in memory as generated, current batch, active batch, planned, pending, or awaiting answers are already planned coverage. Do not generate them again; generate after them.",
    "memoryPatch must replace ## Frontier Queue with the remaining ordered queue after the generated targets, plus enough future targets to keep the next generation unambiguous.",
    "memoryPatch must update ## Target Ledger: mark generated targets planned, answered high-score targets strong, low-score targets weak or partial, and leave future uncovered targets todo.",
    "If pending planned targets remain, still generate later targets after those pending targets unless the full curriculum map is already covered or pending.",
    "Never fill unused batch slots with review, recap, or practice duplicates. Learn generation should introduce uncovered targets or repair weak targets; otherwise return fewer questions.",
    "Never mark Completion complete in a response that returns any questions.",
    "For empty or vague memory, first infer the simplest beginner sequence. For finite goals, keep the curriculum map explicit enough that completion is auditable.",
    "For alphabet, script, or syllabary goals, treat the default scope as character recognition plus the standard/common transliteration named or implied by the goal. Do not expand into example words, spelling rules, particle readings, long-vowel conventions, historical variants, or comparisons between romanization systems unless the goal explicitly asks for those.",
    "The memoryPatch must be a diff: replace or append only changed sections. Do not return the whole memory. Keep sections compact so future prompts remain bounded.",
    "Do not mark newly generated questions as mastered; only update memory from existing memory and answered performance. Dedupe happens after your response.",
    buildQuestionQualityPromptBlock(questionQualityReference),
    "Return zero questions only when memory and performance show no useful uncovered or weak target remains.",
    "Return JSON only:",
    '{"questions":[{"question":"...","conciseAnswer":"short expected answer","questionProvenance":"why now"}],"memoryPatch":[{"op":"replace_section","heading":"Frontier","body":"- ..."}]}',
  ].join("\n\n");
}

function buildCompletionAuditSystemPrompt(questionQualityReference: string): string {
  return [
    "You are Waxon's generic deck-memory completion auditor. A planner has returned zero questions; verify whether that is actually justified.",
    "Use the deck goal, current memory, and recent performance. Do not use app hardcodes or deck-specific templates; use your own domain knowledge to audit the goal's real scope.",
    "Assume the planner may have accidentally narrowed a broad goal into an introductory or prerequisite subset. This is especially important for goals using words like all, every, entire, complete, comprehensive, master, or full.",
    "Return complete true only when the Curriculum Map and Target Ledger visibly cover the deck goal's full intended scope, or when memory explicitly documents reasonable exclusions that make the remaining scope out of goal.",
    "If the memory is narrower than the goal, return complete false, expand the relevant memory sections with a diff, and generate the next ordered frontier questions.",
    "If useful uncovered targets remain but you are uncertain about the exact full scope, keep Completion not complete and generate the best next boundary-expanding questions rather than stopping.",
    "For alphabet, script, or syllabary goals, do not treat example words, spelling rules, particle readings, long-vowel conventions, historical variants, or comparisons between romanization systems as uncovered scope unless the goal explicitly asks for those.",
    "If the user lists candidates rejected as duplicate/non-novel, those exact atomic targets are unavailable. Do not return them again. If they correspond to planned or frontier memory targets, update memoryPatch to mark them covered or remove them from Frontier Queue, then choose different uncovered targets or confirm completion.",
    "Preserve target text exactly in memory for symbols, formulas, code identifiers, names, terms, or other atomic targets. Copy exact target strings from generated questions and answered performance.",
    "Never generate review, recap, or practice duplicates. Only introduce uncovered targets or repair weak targets.",
    `Generate up to ${LEARN_BATCH_SIZE} questions if completion is not justified.`,
    buildQuestionQualityPromptBlock(questionQualityReference),
    "Return JSON only:",
    '{"complete":false,"reason":"brief audit reason","questions":[{"question":"...","conciseAnswer":"short expected answer","questionProvenance":"why now"}],"memoryPatch":[{"op":"replace_section","heading":"Frontier","body":"- ..."}]}',
  ].join("\n\n");
}

function learnGenerationModels(): string[] {
  return OPENROUTER_MODEL ? [OPENROUTER_MODEL] : [];
}

async function generateLearnCompletion(input: {
  apiKey: string;
  userId: string;
  deckId: string;
  operation?: string;
  body: Omit<Parameters<typeof openRouterChatCompletion>[0]["body"], "model">;
}): Promise<
  | { ok: true; result: LearnCompletionResult }
  | { ok: false; failures: string[] }
> {
  const failures: string[] = [];

  for (const model of learnGenerationModels()) {
    const { response, body } = await openRouterChatCompletion({
      apiKey: input.apiKey,
      trace: {
        operation: input.operation ?? "learn_mode_generate_questions",
        userId: input.userId,
        deckId: input.deckId,
      },
      body: {
        ...input.body,
        model,
      },
    });

    if (response.ok) {
      const content = extractChatCompletionText(body);

      if (!content) {
        failures.push(`${model} (empty)`);
        continue;
      }

      let json: unknown;

      try {
        json = extractJsonObject(content);
      } catch {
        failures.push(`${model} (invalid-json)`);
        continue;
      }

      return {
        ok: true,
        result: {
          model,
          body,
          json,
        },
      };
    }

    failures.push(`${model} (${response.status})`);
  }

  return {
    ok: false,
    failures,
  };
}

async function auditLearnCompletion(input: {
  apiKey: string;
  userId: string;
  deckId: string;
  deck: { name: string; goal: string };
  memory: string;
  questionCount: number;
  previousAnswers: PreviousAnswerContext[];
  persistedPreviousAnswers: PreviousAnswerContext[];
  rejectedDuplicateCandidates?: LearnQuestionPayload[];
  questionQualityReference: string;
}): Promise<
  | { ok: true; result: LearnCompletionResult }
  | { ok: false; failures: string[] }
> {
  return generateLearnCompletion({
    apiKey: input.apiKey,
    userId: input.userId,
    deckId: input.deckId,
    operation: "learn_mode_completion_audit",
    body: {
      temperature: 0.2,
      max_tokens: Math.max(50, LEARN_GENERATION_MAX_TOKENS),
      reasoning: {
        max_tokens: Math.max(0, LEARN_REASONING_MAX_TOKENS),
        exclude: true,
      },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildCompletionAuditSystemPrompt(input.questionQualityReference),
        },
        {
          role: "user",
          content: [
            `Audit completion and generate up to ${input.questionCount} questions if the deck is not complete.`,
            "Deck:",
            JSON.stringify(input.deck),
            "Current MEMORY.md:",
            input.memory,
            "Recent in-session answers from the current Learn context:",
            JSON.stringify(input.previousAnswers.slice(0, MAX_PREVIOUS_ANSWERS)),
            "Recent target-deck answer attempts and scores:",
            JSON.stringify(
              input.persistedPreviousAnswers.slice(0, MAX_PREVIOUS_ANSWERS),
            ),
            input.rejectedDuplicateCandidates?.length
              ? [
                  "Recently generated candidates rejected as duplicate/non-novel by Waxon's dedupe gate:",
                  JSON.stringify(
                    input.rejectedDuplicateCandidates.slice(0, LEARN_BATCH_SIZE),
                  ),
                  "Do not repeat those rejected candidates. Either choose genuinely distinct uncovered targets or update memory to mark that duplicate frontier as covered.",
                ].join("\n\n")
              : "",
          ].join("\n\n"),
        },
      ],
    },
  });
}

function chooseTargetDeck(input: {
  decks: DeckSummary[];
  requestedDeckId: string;
}): DeckSummary | null {
  if (input.requestedDeckId) {
    return input.decks.find((deck) => deck.id === input.requestedDeckId) ?? null;
  }

  return (
    input.decks.find((deck) => deck.inReviewRotation && deck.coverage.trim()) ??
    input.decks.find((deck) => deck.inReviewRotation) ??
    null
  );
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_LEARN_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "OPENROUTER_API_KEY is not configured." },
      { status: 500 },
    );
  }

  if (!OPENROUTER_MODEL) {
    return NextResponse.json(
      { ok: false, error: "LLM_MODEL is not configured." },
      { status: 500 },
    );
  }

  const user = await getCurrentUser();
  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const requestedDeckId = normalizeBoundedText(payload.deckId, {
    field: "deckId",
    maxLength: MAX_DECK_ID_CHARS,
  });
  const requestedSourceDeckId = normalizeBoundedText(payload.sourceDeckId, {
    field: "sourceDeckId",
    maxLength: MAX_DECK_ID_CHARS,
  });

  if (!requestedDeckId.ok) {
    return requestedDeckId.response;
  }

  if (!requestedSourceDeckId.ok) {
    return requestedSourceDeckId.response;
  }

  const currentQuestion = normalizeText(payload.currentQuestion, MAX_QUESTION_CHARS);
  const questionCount = normalizeQuestionCount(payload.count);
  const previousAnswers = normalizePreviousAnswers(payload.previousAnswers);

  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "questions-learn",
    rules: [
      { name: "minute", max: 30, windowMs: 60_000 },
      { name: "day", max: 600, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  await ensureQuestionsDatabase();

  let targetDeckId = "";

  if (requestedDeckId.value) {
    try {
      targetDeckId = await resolveOwnedDeckId({
        userId: user.id,
        deckId: requestedDeckId.value,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Deck not found.";

      return NextResponse.json(
        { ok: false, error: message },
        { status: message === "Deck not found." ? 404 : 500 },
      );
    }
  }

  let sourceDeckId = "";

  if (requestedSourceDeckId.value) {
    try {
      sourceDeckId = await resolveOwnedDeckId({
        userId: user.id,
        deckId: requestedSourceDeckId.value,
      });
    } catch {
      sourceDeckId = "";
    }
  }

  const decks = await listDecks({ userId: user.id });
  const targetDeck = chooseTargetDeck({
    decks,
    requestedDeckId: targetDeckId,
  });

  if (!targetDeck) {
    return NextResponse.json(
      { ok: false, error: "No review deck is available for learn mode." },
      { status: 400 },
    );
  }

  const activeTargetDeck = targetDeck.inReviewRotation
    ? targetDeck
    : await updateDeck({
        deckId: targetDeck.id,
        userId: user.id,
        inReviewRotation: true,
      });

  const persistedAttempts = await getRecentQuestionAttempts({
    userId: user.id,
    deckId: activeTargetDeck.id,
    limit: MAX_PREVIOUS_ANSWERS,
  });
  const persistedPreviousAnswers = persistedAttempts.map((attempt) => ({
    question: attempt.question,
    answer: attempt.rawAnswer || attempt.answerSummary,
    score: attempt.score,
    justification: attempt.justification,
  }));
  const sourceQuestion =
    sourceDeckId && sourceDeckId === activeTargetDeck.id
      ? currentQuestion || null
      : null;

  const questionQualityReference = getQuestionQualityReference();
  const deck = {
    name: activeTargetDeck.name,
    goal: activeTargetDeck.coverage || activeTargetDeck.name,
  };
  const currentMemory = normalizeDeckMemory(activeTargetDeck.memory, deck);
  const completion = await generateLearnCompletion({
    apiKey,
    userId: user.id,
    deckId: activeTargetDeck.id,
    body: {
      temperature: 0.35,
      max_tokens: Math.max(50, LEARN_GENERATION_MAX_TOKENS),
      reasoning: {
        max_tokens: Math.max(0, LEARN_REASONING_MAX_TOKENS),
        exclude: true,
      },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildLearnSystemPrompt(questionQualityReference),
        },
        {
          role: "user",
          content: [
            `Generate up to ${questionCount} new questions.`,
            "Deck:",
            JSON.stringify(deck),
            "Current MEMORY.md:",
            currentMemory,
            currentQuestion
              ? ["Current question being answered:", currentQuestion].join("\n")
              : "",
            "Recent in-session answers from the current Learn context:",
            JSON.stringify(
              previousAnswers.slice(0, MAX_PREVIOUS_ANSWERS),
            ),
            "Recent target-deck answer attempts and scores:",
            JSON.stringify(
              persistedPreviousAnswers.slice(0, MAX_PREVIOUS_ANSWERS),
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
  });

  if (!completion.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `OpenRouter learn generation failed for all models: ${completion.failures.join(", ")}.`,
      },
      { status: 502 },
    );
  }

  const generatedQuestions = normalizeGeneratedQuestions(
    completion.result.json,
    questionCount,
  );
  const memoryPatch = normalizeMemoryPatch(completion.result.json);
  const nextMemory = applyMemoryPatch(currentMemory, memoryPatch, {
    hasGeneratedQuestions: generatedQuestions.length > 0,
  });

  if (nextMemory !== activeTargetDeck.memory.trim()) {
    await updateDeck({
      deckId: activeTargetDeck.id,
      userId: user.id,
      memory: nextMemory,
    });
  }

  if (generatedQuestions.length === 0) {
    const audit = await auditLearnCompletion({
      apiKey,
      userId: user.id,
      deckId: activeTargetDeck.id,
      deck,
      memory: nextMemory,
      questionCount,
      previousAnswers,
      persistedPreviousAnswers,
      rejectedDuplicateCandidates: generatedQuestions,
      questionQualityReference,
    });

    if (!audit.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `OpenRouter learn completion audit failed for all models: ${audit.failures.join(", ")}.`,
        },
        { status: 502 },
      );
    }

    const auditQuestions = normalizeGeneratedQuestions(audit.result.json, questionCount);
    const auditPatch = normalizeMemoryPatch(audit.result.json);
    const auditedMemory = applyMemoryPatch(nextMemory, auditPatch, {
      hasGeneratedQuestions: auditQuestions.length > 0,
    });

    if (auditedMemory !== activeTargetDeck.memory.trim()) {
      await updateDeck({
        deckId: activeTargetDeck.id,
        userId: user.id,
        memory: auditedMemory,
      });
    }

    if (auditQuestions.length > 0) {
      const auditQuestionInputs: QuestionInput[] = auditQuestions.map((question) => ({
        question: question.question,
        conciseAnswer: question.conciseAnswer,
        questionProvenance: question.questionProvenance,
      }));
      const auditResult = await addQuestionsToDeck({
        questions: auditQuestionInputs,
        deckId: activeTargetDeck.id,
        sourceQuestion,
      });
      const auditDone =
        !currentQuestion &&
        auditResult.added === 0 &&
        !memoryHasPendingCoverage(auditedMemory);
      const completedMemory = auditDone
        ? completeLearnMemory(auditedMemory)
        : auditedMemory;

      if (completedMemory !== auditedMemory) {
        await updateDeck({
          deckId: activeTargetDeck.id,
          userId: user.id,
          memory: completedMemory,
        });
      }

      return NextResponse.json({
        ok: true,
        model: audit.result.model,
        done: auditDone,
        added: auditResult.added,
        rejected: auditResult.rejected,
        questions: auditDone ? [] : auditQuestions,
        memoryUpdated:
          memoryPatch.length > 0 ||
          auditPatch.length > 0 ||
          completedMemory !== auditedMemory,
        auditedCompletion: true,
      });
    }

    const auditDone =
      !currentQuestion &&
      normalizeAuditComplete(audit.result.json) &&
      !memoryHasPendingCoverage(auditedMemory);
    const completedMemory = auditDone ? completeLearnMemory(auditedMemory) : auditedMemory;

    if (completedMemory !== auditedMemory) {
      await updateDeck({
        deckId: activeTargetDeck.id,
        userId: user.id,
        memory: completedMemory,
      });
    }

    return NextResponse.json({
      ok: true,
      model: audit.result.model,
      done: auditDone,
      added: 0,
      rejected: 0,
      questions: [],
      memoryUpdated:
        memoryPatch.length > 0 ||
        auditPatch.length > 0 ||
        completedMemory !== auditedMemory,
      auditedCompletion: true,
    });
  }

  const questionInputs: QuestionInput[] = generatedQuestions.map((question) => ({
    question: question.question,
    conciseAnswer: question.conciseAnswer,
    questionProvenance: question.questionProvenance,
  }));
  const result = await addQuestionsToDeck({
    questions: questionInputs,
    deckId: activeTargetDeck.id,
    sourceQuestion,
  });

  if (result.added === 0) {
    const audit = await auditLearnCompletion({
      apiKey,
      userId: user.id,
      deckId: activeTargetDeck.id,
      deck,
      memory: nextMemory,
      questionCount,
      previousAnswers,
      persistedPreviousAnswers,
      rejectedDuplicateCandidates: generatedQuestions,
      questionQualityReference,
    });

    if (!audit.ok) {
      return NextResponse.json({
        ok: true,
        model: completion.result.model,
        done: false,
        added: result.added,
        rejected: result.rejected,
        questions: generatedQuestions,
        memoryUpdated: memoryPatch.length > 0,
        auditError: `OpenRouter learn completion audit failed for all models: ${audit.failures.join(", ")}.`,
      });
    }

    const auditQuestions = normalizeGeneratedQuestions(audit.result.json, questionCount);
    const auditPatch = normalizeMemoryPatch(audit.result.json);
    const auditedMemory = applyMemoryPatch(nextMemory, auditPatch, {
      hasGeneratedQuestions: auditQuestions.length > 0,
    });

    if (auditedMemory !== activeTargetDeck.memory.trim()) {
      await updateDeck({
        deckId: activeTargetDeck.id,
        userId: user.id,
        memory: auditedMemory,
      });
    }

    if (auditQuestions.length > 0) {
      const auditQuestionInputs: QuestionInput[] = auditQuestions.map((question) => ({
        question: question.question,
        conciseAnswer: question.conciseAnswer,
        questionProvenance: question.questionProvenance,
      }));
      const auditResult = await addQuestionsToDeck({
        questions: auditQuestionInputs,
        deckId: activeTargetDeck.id,
        sourceQuestion,
      });
      const auditDone =
        !currentQuestion &&
        auditResult.added === 0 &&
        !memoryHasPendingCoverage(auditedMemory);
      const completedMemory = auditDone
        ? completeLearnMemory(auditedMemory)
        : auditedMemory;

      if (completedMemory !== auditedMemory) {
        await updateDeck({
          deckId: activeTargetDeck.id,
          userId: user.id,
          memory: completedMemory,
        });
      }

      return NextResponse.json({
        ok: true,
        model: audit.result.model,
        done: auditDone,
        added: auditResult.added,
        rejected: result.rejected + auditResult.rejected,
        questions: auditDone ? [] : auditQuestions,
        memoryUpdated:
          memoryPatch.length > 0 ||
          auditPatch.length > 0 ||
          completedMemory !== auditedMemory,
        auditedCompletion: true,
      });
    }

    const auditDone =
      !currentQuestion &&
      normalizeAuditComplete(audit.result.json) &&
      !memoryHasPendingCoverage(auditedMemory);
    const completedMemory = auditDone ? completeLearnMemory(auditedMemory) : auditedMemory;

    if (completedMemory !== auditedMemory) {
      await updateDeck({
        deckId: activeTargetDeck.id,
        userId: user.id,
        memory: completedMemory,
      });
    }

    return NextResponse.json({
      ok: true,
      model: audit.result.model,
      done: auditDone,
      added: 0,
      rejected: result.rejected,
      questions: [],
      memoryUpdated:
        memoryPatch.length > 0 ||
        auditPatch.length > 0 ||
        completedMemory !== auditedMemory,
      auditedCompletion: true,
    });
  }

  return NextResponse.json({
    ok: true,
    model: completion.result.model,
    done: false,
    added: result.added,
    rejected: result.rejected,
    questions: generatedQuestions,
    memoryUpdated: memoryPatch.length > 0,
  });
}
