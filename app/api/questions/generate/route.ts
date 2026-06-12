import { NextResponse } from "next/server";
import { pool } from "@/app/db/client";
import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
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
  getOpenRouterChatConfig,
  openRouterChatCompletion,
  openRouterEmbeddings,
} from "@/app/lib/openRouter";
import { extractJsonObject } from "@/app/lib/jsonObject";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";
import { vectorLiteral } from "@/app/lib/vectorLiteral";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_GENERATE_BODY_BYTES = 96 * 1024;
const MAX_DECK_ID_CHARS = 200;
const MAX_SCOPE_CHARS = 12_000;
const MAX_FILE_COUNT = 6;
const MAX_FILE_NAME_CHARS = 160;
const MAX_FILE_CONTENT_CHARS = 20_000;
const MAX_TOTAL_FILE_CONTENT_CHARS = 32_000;
const MAX_DIFFICULTY_CHARS = 40;
const MAX_EXISTING_QUESTION_COUNT = 200;
const MAX_EXISTING_QUESTION_CHARS = 1_200;
const MAX_MODAL_QUESTION_COUNT = 120;
const MAX_MODAL_CONCISE_ANSWER_CHARS = 800;
const MAX_MODAL_COVERAGE_LABEL_CHARS = 240;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 1_600;
const MAX_DIRECT_GENERATION_CONTEXT_CHARS = 6_000;
const MAX_GENERATION_CONTEXT_EXCERPT_CHARS = 12_000;
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
  proposedConceptSlugs?: string[];
  sourceText?: string;
};

type ExistingQuestionContext = {
  question: string;
  conciseAnswer: string;
  coverageLabel: string;
};

type NormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse };

function validationError(error: string): NormalizeResult<never> {
  return {
    ok: false,
    response: NextResponse.json({ ok: false, error }, { status: 400 }),
  };
}

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

function normalizeFiles(value: unknown): NormalizeResult<ContextFilePayload[]> {
  if (!Array.isArray(value)) {
    return { ok: true, value: [] };
  }

  if (value.length > MAX_FILE_COUNT) {
    return validationError(`files can include at most ${MAX_FILE_COUNT} items.`);
  }

  const files: ContextFilePayload[] = [];
  let totalContentLength = 0;

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const name = normalizeText(record.name);
    const content = normalizeText(record.content);
    const status = normalizeText(record.status);

    if (name.length > MAX_FILE_NAME_CHARS) {
      return validationError(
        `file name must be ${MAX_FILE_NAME_CHARS} characters or fewer.`,
      );
    }

    if (content.length > MAX_FILE_CONTENT_CHARS) {
      return validationError(
        `file content must be ${MAX_FILE_CONTENT_CHARS} characters or fewer.`,
      );
    }

    if (status.length > MAX_DIFFICULTY_CHARS) {
      return validationError(
        `file status must be ${MAX_DIFFICULTY_CHARS} characters or fewer.`,
      );
    }

    if (!name && !content) {
      continue;
    }

    totalContentLength += content.length;

    if (totalContentLength > MAX_TOTAL_FILE_CONTENT_CHARS) {
      return validationError(
        `total file content must be ${MAX_TOTAL_FILE_CONTENT_CHARS} characters or fewer.`,
      );
    }

    files.push({
      name: name || "context",
      content,
      status,
    });
  }

  return { ok: true, value: files };
}

function normalizeExistingQuestions(value: unknown): NormalizeResult<Set<string>> {
  if (!Array.isArray(value)) {
    return { ok: true, value: new Set() };
  }

  if (value.length > MAX_EXISTING_QUESTION_COUNT) {
    return validationError(
      `existingQuestions can include at most ${MAX_EXISTING_QUESTION_COUNT} items.`,
    );
  }

  const questions = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const question = item.trim();

    if (question.length > MAX_EXISTING_QUESTION_CHARS) {
      return validationError(
        `existingQuestions items must be ${MAX_EXISTING_QUESTION_CHARS} characters or fewer.`,
      );
    }

    if (question) {
      questions.add(question.toLowerCase());
    }
  }

  return { ok: true, value: questions };
}

function normalizeExistingQuestionContexts(
  value: unknown,
): NormalizeResult<ExistingQuestionContext[]> {
  if (!Array.isArray(value)) {
    return { ok: true, value: [] };
  }

  if (value.length > MAX_MODAL_QUESTION_COUNT) {
    return validationError(
      `modalQuestions can include at most ${MAX_MODAL_QUESTION_COUNT} items.`,
    );
  }

  const seen = new Set<string>();
  const normalized: ExistingQuestionContext[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const question = normalizeText(record.question).replace(/\s+/g, " ");
    const conciseAnswer = normalizeText(record.conciseAnswer).replace(/\s+/g, " ");
    const coverageLabel = normalizeText(record.coverageLabel).replace(/\s+/g, " ");
    const key = question.toLowerCase();

    if (question.length > MAX_EXISTING_QUESTION_CHARS) {
      return validationError(
        `modalQuestions question must be ${MAX_EXISTING_QUESTION_CHARS} characters or fewer.`,
      );
    }

    if (conciseAnswer.length > MAX_MODAL_CONCISE_ANSWER_CHARS) {
      return validationError(
        `modalQuestions conciseAnswer must be ${MAX_MODAL_CONCISE_ANSWER_CHARS} characters or fewer.`,
      );
    }

    if (coverageLabel.length > MAX_MODAL_COVERAGE_LABEL_CHARS) {
      return validationError(
        `modalQuestions coverageLabel must be ${MAX_MODAL_COVERAGE_LABEL_CHARS} characters or fewer.`,
      );
    }

    if (!question || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      conciseAnswer,
      coverageLabel,
    });
  }

  return { ok: true, value: normalized };
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
    "Maximize coverage across the content instead of making variants of the same point.",
    "Avoid generic questions such as 'What is the key idea behind the topic?'",
    "Each question needs a short expected answer for dedupe embeddings; do not include explanations, numbering, or preambles.",
    "Do not duplicate existing questions, near-duplicates, or current modal review queue questions.",
    "Return compact keys: q=question, a=short expected answer, s=prompt or filename, c=covered concept slug.",
    "The c value must be one full self-disambiguating lowercase kebab-case concept slug, not an acronym-only tag.",
    "Return JSON only:",
    '{"questions":[{"q":"...","a":"short expected answer","s":"Prompt or filename","c":"concept-slug"}]}',
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

    const question = normalizeText(record.question ?? record.q).replace(/\s+/g, " ");
    const conciseAnswer = normalizeText(record.conciseAnswer ?? record.a).replace(/\s+/g, " ");
    const key = question.toLowerCase();

    if (!question || !conciseAnswer || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      conciseAnswer,
      sourceLabel: normalizeText(record.sourceLabel ?? record.s) || "OpenRouter",
      coverageLabel: normalizeText(record.coverageLabel ?? record.c) || question,
      proposedConceptSlugs: Array.isArray(record.conceptSlugs)
        ? record.conceptSlugs.map(normalizeText).filter(Boolean)
        : [normalizeText(record.proposedConceptSlug ?? record.c)].filter(Boolean),
      sourceText: normalizeText(record.sourceText ?? record.s),
    });
  }

  return normalized;
}

function buildContextExcerpt(context: string): string {
  if (context.length <= MAX_GENERATION_CONTEXT_EXCERPT_CHARS) {
    return context;
  }

  const headLength = Math.floor(MAX_GENERATION_CONTEXT_EXCERPT_CHARS * 0.65);
  const tailLength = MAX_GENERATION_CONTEXT_EXCERPT_CHARS - headLength;

  return [
    context.slice(0, headLength),
    "[...middle omitted for token budget...]",
    context.slice(-tailLength),
  ].join("\n");
}

function buildGenerationContextPrompt(input: {
  context: string;
  contextSummary: string;
}): string[] {
  if (input.context.length <= MAX_DIRECT_GENERATION_CONTEXT_CHARS) {
    return ["Content:", input.context];
  }

  return [
    "Coverage summary:",
    input.contextSummary,
    "Selected content excerpts:",
    buildContextExcerpt(input.context),
  ];
}

async function summarizeGenerationContext(input: {
  apiKey: string;
  model: string;
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
      model: input.model,
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
  const parsed = await readJsonBodyWithLimit(request, MAX_GENERATE_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const openRouterConfig = getOpenRouterChatConfig();

  if (!openRouterConfig.ok) {
    return NextResponse.json(
      { ok: false, error: openRouterConfig.error },
      { status: 500 },
    );
  }

  const { apiKey, model } = openRouterConfig;

  const user = await getCurrentUser();
  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const requestedDeckId = normalizeBoundedText(payload.deckId, {
    field: "deckId",
    maxLength: MAX_DECK_ID_CHARS,
  });

  if (!requestedDeckId.ok) {
    return requestedDeckId.response;
  }

  const scope = normalizeBoundedText(payload.scope, {
    field: "scope",
    maxLength: MAX_SCOPE_CHARS,
  });

  if (!scope.ok) {
    return scope.response;
  }

  const files = normalizeFiles(payload.files);

  if (!files.ok) {
    return files.response;
  }

  const difficulty = normalizeBoundedText(payload.difficulty, {
    field: "difficulty",
    maxLength: MAX_DIFFICULTY_CHARS,
  });

  if (!difficulty.ok) {
    return difficulty.response;
  }

  const count = normalizeQuestionCount(payload.count);
  const existingQuestions = normalizeExistingQuestions(payload.existingQuestions);

  if (!existingQuestions.ok) {
    return existingQuestions.response;
  }

  const modalQuestions = normalizeExistingQuestionContexts(payload.modalQuestions);

  if (!modalQuestions.ok) {
    return modalQuestions.response;
  }

  if (!scope.value && files.value.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Add a topic or attach context before generating." },
      { status: 400 },
    );
  }

  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "questions-generate",
    rules: [
      { name: "minute", max: 5, windowMs: 60_000 },
      { name: "day", max: 40, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  await ensureQuestionsDatabase();
  let deckId: string;

  try {
    deckId = await resolveOwnedDeckId({
      userId: user.id,
      deckId: requestedDeckId.value || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deck not found.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Deck not found." ? 404 : 500 },
    );
  }

  const context = buildContext({ scope: scope.value, files: files.value });
  const contextSummary =
    context.length <= MAX_DIRECT_GENERATION_CONTEXT_CHARS
      ? context.slice(0, MAX_SUMMARY_CHARS)
      : await summarizeGenerationContext({
          apiKey,
          model,
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
      model,
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
            `Difficulty: ${difficulty.value || "Mixed"}.`,
            existingQuestions.value.size > 0
              ? `Existing questions to avoid:\n${Array.from(existingQuestions.value)
                  .slice(0, 200)
                  .join("\n")}`
              : "",
            modalQuestions.value.length > 0
              ? [
                  "Questions already generated in the current modal review queue:",
                  JSON.stringify(
                    modalQuestions.value.map((item) => ({
                      q: item.question,
                      a: item.conciseAnswer,
                      c: item.coverageLabel,
                    })),
                  ),
                  "Treat these targets as covered.",
                ].join("\n\n")
              : "",
            generationNeighbors.length > 0
              ? [
                  "Nearby already-covered questions from the deck:",
                  JSON.stringify(
                    generationNeighbors.map((neighbor) => ({
                      q: neighbor.question,
                      a: neighbor.conciseAnswer,
                      sim: neighbor.similarity,
                    })),
                  ),
                  "Fill gaps, boundaries, prerequisites, or adjacent failure modes instead of paraphrasing these.",
                ].join("\n\n")
              : "",
            ...buildGenerationContextPrompt({ context, contextSummary }),
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
    existingQuestions.value,
  ).slice(0, count);

  return NextResponse.json({
    ok: true,
    model,
    questions: generated,
  });
}
