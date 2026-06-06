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
  readQuestions,
  resolveOwnedDeckId,
  updateDeck,
  type DeckSummary,
  type QuestionInput,
} from "@/app/lib/postgresStore";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_MODEL = process.env.LLM_MODEL || "openai/gpt-5.5";
const LEARN_BATCH_SIZE = 2;
const MAX_LEARN_BODY_BYTES = 48 * 1024;
const MAX_DECK_ID_CHARS = 200;
const MAX_QUESTION_CHARS = 1_200;
const MAX_ANSWER_CHARS = 2_000;
const MAX_JUSTIFICATION_CHARS = 2_000;
const MAX_PREVIOUS_ANSWERS = 12;
const MAX_EXISTING_CONTEXT_QUESTIONS = 160;
const MAX_PROVENANCE_CHARS = 360;
const HIRAGANA_CURRICULUM = [
  ["あ", "a"],
  ["い", "i"],
  ["う", "u"],
  ["え", "e"],
  ["お", "o"],
  ["か", "ka"],
  ["き", "ki"],
  ["く", "ku"],
  ["け", "ke"],
  ["こ", "ko"],
  ["さ", "sa"],
  ["し", "shi"],
  ["す", "su"],
  ["せ", "se"],
  ["そ", "so"],
  ["た", "ta"],
  ["ち", "chi"],
  ["つ", "tsu"],
  ["て", "te"],
  ["と", "to"],
  ["な", "na"],
  ["に", "ni"],
  ["ぬ", "nu"],
  ["ね", "ne"],
  ["の", "no"],
  ["は", "ha"],
  ["ひ", "hi"],
  ["ふ", "fu"],
  ["へ", "he"],
  ["ほ", "ho"],
  ["ま", "ma"],
  ["み", "mi"],
  ["む", "mu"],
  ["め", "me"],
  ["も", "mo"],
  ["や", "ya"],
  ["ゆ", "yu"],
  ["よ", "yo"],
  ["ら", "ra"],
  ["り", "ri"],
  ["る", "ru"],
  ["れ", "re"],
  ["ろ", "ro"],
  ["わ", "wa"],
  ["を", "o"],
  ["ん", "n"],
] as const;

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

type ExistingQuestionContext = {
  question: string;
};

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
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
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(LEARN_BATCH_SIZE, Math.max(1, Math.floor(value)))
    : LEARN_BATCH_SIZE;
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

    if (!question || !conciseAnswer || !questionProvenance || seen.has(key)) {
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

function isHiraganaDeck(deck: DeckSummary): boolean {
  return `${deck.name} ${deck.coverage ?? ""}`.toLowerCase().includes("hiragana");
}

function buildHiraganaLearnQuestions(
  existingQuestions: ExistingQuestionContext[],
  questionCount: number,
): LearnQuestionPayload[] {
  const existingQuestionText = existingQuestions
    .map((question) => question.question)
    .join("\n");

  return HIRAGANA_CURRICULUM
    .map(([kana, romaji], index) => ({ index, kana, romaji }))
    .filter(({ kana }) => !existingQuestionText.includes(kana))
    .slice(0, questionCount)
    .map(({ index, kana, romaji }) => ({
      question: `Hiragana ${index + 1}: what is the romaji reading of ${kana}?`,
      conciseAnswer: `${kana} is read as ${romaji}.`,
      questionProvenance:
        "Next beginner hiragana kana-to-romaji recall target.",
    }));
}

function buildLearnSystemPrompt(questionQualityReference: string): string {
  return [
    "You generate new spaced-repetition questions while a learner is in learn mode.",
    "Learn mode introduces new material at the learner's current frontier; it is not for reviewing previously answered cards.",
    "When the deck has no existing questions or answers, assume the learner is an absolute beginner and generate the first prerequisite recall targets for the deck goal.",
    "For sequential domains, generate the earliest uncovered items in the natural teaching order, one small recall target at a time.",
    "For writing systems or alphabets, start with the first symbol-sound mapping and ask for the romanized reading before later symbols or combinations.",
    "For a deck like Japanese - Hiragana, the first questions should be beginner kana-to-romaji recall, such as asking for the romaji reading of the simplest first kana, before moving through the rest of hiragana.",
    "When the deck already has questions, continue from the earliest uncovered prerequisite or adjacent recall target shown by the deck goal, existing questions, and recent previous answers.",
    "Every generated question must follow the shared question-quality reference below.",
    "Each question must include a concise expected answer for dedupe embeddings.",
    "Each question must include questionProvenance: a short reason why this question was generated from the deck goal and previous answers.",
    "The provenance must come from this same generation call and must not reveal the answer.",
    "Avoid duplicate or near-duplicate recall targets from the existing deck questions.",
    "Return JSON only with this exact shape:",
    '{"questions":[{"question":"...","conciseAnswer":"short expected answer","questionProvenance":"why this question was generated"}]}',
    "Shared question-quality reference:",
    questionQualityReference,
  ].join("\n\n");
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
      { name: "minute", max: 8, windowMs: 60_000 },
      { name: "day", max: 120, windowMs: 24 * 60 * 60_000 },
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

  const [existingQuestions, persistedAttempts] = await Promise.all([
    readQuestions({ userId: user.id, deckId: activeTargetDeck.id }),
    getRecentQuestionAttempts({
      userId: user.id,
      deckId: activeTargetDeck.id,
      limit: MAX_PREVIOUS_ANSWERS,
    }),
  ]);
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

  if (isHiraganaDeck(activeTargetDeck)) {
    const questions = buildHiraganaLearnQuestions(
      existingQuestions,
      questionCount,
    );
    const result = await addQuestionsToDeck({
      questions,
      deckId: activeTargetDeck.id,
      sourceQuestion,
      skipSemanticDedupe: true,
    });

    return NextResponse.json({
      ok: true,
      model: "waxon/hiragana-curriculum",
      added: result.added,
      rejected: result.rejected,
      questions,
    });
  }

  const questionQualityReference = getQuestionQualityReference();
  const { response, body } = await openRouterChatCompletion({
    apiKey,
    trace: {
      operation: "learn_mode_generate_questions",
      userId: user.id,
      deckId: activeTargetDeck.id,
    },
    body: {
      model: OPENROUTER_MODEL,
      temperature: 0.35,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildLearnSystemPrompt(questionQualityReference),
        },
        {
          role: "user",
          content: [
            `Generate exactly ${questionCount} new questions.`,
            "Deck:",
            JSON.stringify({
              name: targetDeck.name,
              goal: targetDeck.coverage || targetDeck.name,
            }),
            currentQuestion
              ? ["Current question being answered:", currentQuestion].join("\n")
              : "",
            "Previous questions and answers:",
            JSON.stringify(
              [...previousAnswers, ...persistedPreviousAnswers].slice(
                0,
                MAX_PREVIOUS_ANSWERS,
              ),
            ),
            "Existing deck questions to avoid:",
            JSON.stringify(
              existingQuestions
                .slice(0, MAX_EXISTING_CONTEXT_QUESTIONS)
                .map((question) => ({
                  question: question.question,
                  conciseAnswer: question.concise_answer,
                })),
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `OpenRouter learn generation failed (${response.status}).`,
      },
      { status: 502 },
    );
  }

  const content = extractChatCompletionText(body);

  if (!content) {
    return NextResponse.json(
      { ok: false, error: "OpenRouter returned no generated content." },
      { status: 502 },
    );
  }

  const questions = normalizeGeneratedQuestions(
    extractJsonObject(content),
    questionCount,
  );

  if (questions.length === 0) {
    return NextResponse.json({
      ok: true,
      model: OPENROUTER_MODEL,
      added: 0,
      rejected: 0,
      questions: [],
    });
  }

  const questionInputs: QuestionInput[] = questions.map((question) => ({
    question: question.question,
    conciseAnswer: question.conciseAnswer,
    questionProvenance: question.questionProvenance,
  }));
  const result = await addQuestionsToDeck({
    questions: questionInputs,
    deckId: activeTargetDeck.id,
    sourceQuestion,
  });

  return NextResponse.json({
    ok: true,
    model: OPENROUTER_MODEL,
    added: result.added,
    rejected: result.rejected,
    questions,
  });
}
