import { NextResponse } from "next/server";
import { pool } from "@/app/db/client";
import {
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  DEFAULT_EMBEDDING_MODEL,
} from "@/app/lib/embeddingSource";
import { getCurrentUser } from "@/app/lib/auth";
import {
  ensureQuestionsDatabase,
  resolveOwnedDeckId,
} from "@/app/lib/postgresStore";
import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "@/app/lib/openRouter";
import { extractJsonObject } from "@/app/lib/jsonObject";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_MODEL = process.env.LLM_MODEL || "openai/gpt-5.5";
const MAX_CONTEXT_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 1_600;
const DEFAULT_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 10;
const GENERATION_NEIGHBOR_COUNT = 32;
const GENERATION_CONTEXT_SUMMARY_SYSTEM_PROMPT = [
  "Summarize desired flashcard coverage scope for semantic retrieval.",
  "Focus on concepts, skills, components, boundaries, prerequisites, and failure modes to cover.",
  `Keep it under ${MAX_SUMMARY_CHARS} characters. Do not list generated questions.`,
].join("\n\n");

type ContextFilePayload = {
  name: string;
  content: string;
  status?: string;
};

type GeneratedQuestionPayload = {
  question: string;
  conciseAnswer: string;
  sourceLabel?: string;
  coverageLabel?: string;
};

type ExistingQuestionContext = {
  question: string;
  conciseAnswer: string;
  coverageLabel: string;
};

function normalizeQuestionCount(value: unknown): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : DEFAULT_QUESTION_COUNT;

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_QUESTION_COUNT;
  }

  return Math.min(MAX_QUESTION_COUNT, Math.max(1, Math.round(numericValue)));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFiles(value: unknown): ContextFilePayload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): ContextFilePayload | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const name = normalizeText(record.name);
      const content = normalizeText(record.content);

      if (!name && !content) {
        return null;
      }

      return {
        name: name || "context",
        content,
        status: normalizeText(record.status),
      };
    })
    .filter((item): item is ContextFilePayload => item !== null);
}

function normalizeExistingQuestions(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeExistingQuestionContexts(
  value: unknown,
): ExistingQuestionContext[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: ExistingQuestionContext[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const question = normalizeText(record.question).replace(/\s+/g, " ");
    const key = question.toLowerCase();

    if (!question || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      conciseAnswer: normalizeText(record.conciseAnswer).replace(/\s+/g, " "),
      coverageLabel: normalizeText(record.coverageLabel).replace(/\s+/g, " "),
    });

    if (normalized.length >= 120) {
      break;
    }
  }

  return normalized;
}

function buildContext(input: {
  scope: string;
  files: ContextFilePayload[];
}): string {
  const fileContext = input.files
    .map((file) =>
      [
        `<file name="${file.name}" status="${file.status || "ready"}">`,
        file.content || "(Only filename was available; infer topic cautiously.)",
        "</file>",
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "<user_request>",
    input.scope || "(No explicit topic text provided.)",
    "</user_request>",
    fileContext ? "<attached_context>\n" + fileContext + "\n</attached_context>" : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

function buildQuestionGenerationSystemPrompt(questionQualityReference: string): string {
  return [
    "You generate high-quality spaced-repetition questions for a study deck.",
    "Every generated question must follow the shared question-quality reference below.",
    "Maximize coverage across the content instead of making variants of the same point.",
    "Avoid generic questions such as 'What is the key idea behind the topic?'",
    "Each question must include a concise expected answer for dedupe embeddings.",
    "The conciseAnswer is not a user-facing explanation. It is the shortest answer that preserves the atomic recall target.",
    "Do not include long explanations, numbering, or preambles.",
    "Do not duplicate existing questions, near-duplicates, or current modal review queue questions.",
    "Return JSON only with this shape:",
    '{"questions":[{"question":"...","conciseAnswer":"short expected answer","sourceLabel":"Prompt or filename","coverageLabel":"short covered concept"}]}',
    "Shared question-quality reference:",
    questionQualityReference,
  ].join("\n\n");
}

function normalizeGeneratedQuestions(
  value: unknown,
  existingQuestions: Set<string>,
): GeneratedQuestionPayload[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const questions = (value as { questions?: unknown }).questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  const seen = new Set(existingQuestions);
  const normalized: GeneratedQuestionPayload[] = [];

  for (const item of questions) {
    const record =
      typeof item === "string"
        ? { question: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;

    if (!record) {
      continue;
    }

    const question = normalizeText(record.question).replace(/\s+/g, " ");
    const conciseAnswer = normalizeText(record.conciseAnswer).replace(/\s+/g, " ");
    const key = question.toLowerCase();

    if (!question || !conciseAnswer || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      conciseAnswer,
      sourceLabel: normalizeText(record.sourceLabel) || "OpenRouter",
      coverageLabel: normalizeText(record.coverageLabel) || question,
    });
  }

  return normalized;
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function summarizeGenerationContext(input: {
  apiKey: string;
  context: string;
  userId: string;
  deckId: string;
}): Promise<string> {
  const { response, body } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    trace: {
      operation: "generate_questions_context_summary",
      userId: input.userId,
      deckId: input.deckId,
    },
    body: {
      model: OPENROUTER_MODEL,
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: GENERATION_CONTEXT_SUMMARY_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: ["Context:", input.context].join("\n\n"),
        },
      ],
    },
  });

  if (!response.ok) {
    return input.context.slice(0, MAX_SUMMARY_CHARS);
  }

  const summary = extractChatCompletionText(body);

  return (summary || input.context).slice(0, MAX_SUMMARY_CHARS);
}

async function fetchSummaryEmbedding(input: {
  apiKey: string;
  summary: string;
  userId: string;
  deckId: string;
}): Promise<number[]> {
  const { response, body } = await openRouterEmbeddings({
    apiKey: input.apiKey,
    trace: {
      operation: "generate_questions_summary_embedding",
      userId: input.userId,
      deckId: input.deckId,
    },
    body: {
      model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input: [input.summary],
      encoding_format: "float",
    },
  });

  if (!response.ok) {
    return [];
  }

  const embedding = body.data?.[0]?.embedding;

  if (!Array.isArray(embedding)) {
    return [];
  }

  return embedding
    .map((component: unknown) => Number(component))
    .filter(Number.isFinite);
}

async function loadGenerationNeighbors(input: {
  apiKey: string;
  summary: string;
  userId: string;
  deckId: string;
}): Promise<
  Array<{
    question: string;
    conciseAnswer: string;
    similarity: number;
  }>
> {
  const embedding = await fetchSummaryEmbedding(input);

  if (embedding.length === 0) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT
        q.question,
        q.concise_answer,
        qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
          <=> $1::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS}) AS distance
      FROM question_embeddings qe
      JOIN questions q ON q.id = qe.question_id
      WHERE qe.deck_id = $2
        AND qe.embedding_model = $3
        AND qe.embedding_kind = $4
        AND qe.source_version = $5
        AND qe.is_current = true
        AND qe.source_hash <> ''
      ORDER BY qe.embedding::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
        <=> $1::halfvec(${DEDUPE_EMBEDDING_DIMENSIONS})
      LIMIT $6
    `,
    [
      vectorLiteral(embedding),
      input.deckId,
      process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      DEDUPE_EMBEDDING_KIND,
      DEDUPE_SOURCE_VERSION,
      GENERATION_NEIGHBOR_COUNT,
    ],
  );

  return result.rows.map((row) => ({
    question: String(row.question ?? ""),
    conciseAnswer: String(row.concise_answer ?? ""),
    similarity: Number((1 - Number(row.distance)).toFixed(4)),
  }));
}

export async function POST(request: Request) {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "OPENROUTER_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const user = await getCurrentUser();
  const payload = body as Record<string, unknown>;
  const requestedDeckId = normalizeText(payload.deckId);
  const scope = normalizeText(payload.scope);
  const files = normalizeFiles(payload.files);
  const difficulty = normalizeText(payload.difficulty) || "Mixed";
  const count = normalizeQuestionCount(payload.count);
  const existingQuestions = normalizeExistingQuestions(payload.existingQuestions);
  const modalQuestions = normalizeExistingQuestionContexts(payload.modalQuestions);

  if (!scope && files.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Add a topic or attach context before generating." },
      { status: 400 },
    );
  }

  await ensureQuestionsDatabase();
  let deckId: string;

  try {
    deckId = await resolveOwnedDeckId({
      userId: user.id,
      deckId: requestedDeckId || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deck not found.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Deck not found." ? 404 : 500 },
    );
  }

  const context = buildContext({ scope, files });
  const contextSummary = await summarizeGenerationContext({
    apiKey,
    context,
    userId: user.id,
    deckId,
  });
  const generationNeighbors = await loadGenerationNeighbors({
    apiKey,
    summary: contextSummary,
    userId: user.id,
    deckId,
  });
  const questionQualityReference = getQuestionQualityReference();
  const { response, body: data } = await openRouterChatCompletion({
    apiKey,
    trace: {
      operation: "generate_questions",
      userId: user.id,
      deckId,
    },
    body: {
      model: OPENROUTER_MODEL,
      temperature: 0.35,
      max_tokens: Math.min(4096, 180 * count + 700),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildQuestionGenerationSystemPrompt(questionQualityReference),
        },
        {
          role: "user",
          content: [
            `Generate exactly ${count} recall questions.`,
            `Difficulty: ${difficulty}.`,
            existingQuestions.size > 0
              ? `Existing questions to avoid:\n${Array.from(existingQuestions)
                  .slice(0, 200)
                  .join("\n")}`
              : "",
            modalQuestions.length > 0
              ? [
                  "Questions already generated in the current modal review queue:",
                  JSON.stringify(
                    modalQuestions.map((item) => ({
                      question: item.question,
                      conciseAnswer: item.conciseAnswer,
                      coverageLabel: item.coverageLabel,
                    })),
                  ),
                  "Do not generate repeats or semantic paraphrases of these. Treat their recall targets as already covered even if they have not been added to the deck yet.",
                ].join("\n\n")
              : "",
            generationNeighbors.length > 0
              ? [
                  "Nearby already-covered questions from the deck:",
                  JSON.stringify(
                    generationNeighbors.map((neighbor) => ({
                      question: neighbor.question,
                      conciseAnswer: neighbor.conciseAnswer,
                      similarity: neighbor.similarity,
                    })),
                  ),
                  "Use these as covered territory. Generate questions that fill gaps, deepen boundaries, add prerequisites, or test adjacent failure modes instead of paraphrasing them.",
                ].join("\n\n")
              : "",
            "Coverage summary used for retrieval:",
            contextSummary,
            "Content:",
            context,
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
        error: `OpenRouter generation failed (${response.status}).`,
      },
      { status: 502 },
    );
  }

  const content = extractChatCompletionText(data);

  if (!content) {
    return NextResponse.json(
      { ok: false, error: "OpenRouter returned no generated content." },
      { status: 502 },
    );
  }

  const generated = normalizeGeneratedQuestions(
    extractJsonObject(content),
    existingQuestions,
  ).slice(0, count);

  return NextResponse.json({
    ok: true,
    model: OPENROUTER_MODEL,
    questions: generated,
  });
}
