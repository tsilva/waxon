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
  requestEmbeddings,
  resolveEmbeddingModel,
} from "@/app/lib/embeddingSource";
import { getCurrentUser } from "@/app/lib/auth";
import {
  extractChatCompletionText,
  getOpenRouterChatConfig,
  openRouterChatCompletion,
} from "@/app/lib/openRouter";
import { extractJsonObject } from "../../../../shared/json-object.mts";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";
import {
  CONCISE_ANSWER_MAX_CHARS,
  QUESTION_GENERATION_DEFAULT_COUNT,
  QUESTION_GENERATION_MAX_COUNT,
  QUESTION_TEXT_MAX_CHARS,
} from "@/app/lib/questionContract";
import { normalizeQuestionDraft } from "@/app/lib/questionDraft";
import { vectorLiteral } from "../../../../shared/vector-literal.mts";

const MAX_GENERATE_BODY_BYTES = 96 * 1024;
const MAX_SCOPE_CHARS = 12_000;
const MAX_FILE_COUNT = 6;
const MAX_FILE_NAME_CHARS = 160;
const MAX_FILE_CONTENT_CHARS = 20_000;
const MAX_TOTAL_FILE_CONTENT_CHARS = 32_000;
const MAX_FILE_STATUS_CHARS = 40;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 1_600;
const MAX_DIRECT_GENERATION_CONTEXT_CHARS = 6_000;
const MAX_GENERATION_CONTEXT_EXCERPT_CHARS = 12_000;
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
  proposedConceptSlugs?: string[];
  sourceText?: string;
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
        : QUESTION_GENERATION_DEFAULT_COUNT;

  if (!Number.isFinite(numericValue)) {
    return QUESTION_GENERATION_DEFAULT_COUNT;
  }

  return Math.min(
    QUESTION_GENERATION_MAX_COUNT,
    Math.max(1, Math.round(numericValue)),
  );
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

    if (status.length > MAX_FILE_STATUS_CHARS) {
      return validationError(
        `file status must be ${MAX_FILE_STATUS_CHARS} characters or fewer.`,
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
    "You generate high-quality spaced-repetition questions for a user's knowledge base.",
    "Maximize coverage across the content instead of making variants of the same point.",
    "Avoid generic questions such as 'What is the key idea behind the topic?'",
    "Each question needs a short expected answer for dedupe embeddings; do not include explanations, numbering, or preambles.",
    "Do not duplicate existing questions or near-duplicates from the knowledge bank.",
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
  existingQuestionIdentities: Set<string>,
): GeneratedQuestionPayload[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const questions = (value as { questions?: unknown }).questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  const seen = new Set(existingQuestionIdentities);
  const normalized: GeneratedQuestionPayload[] = [];

  for (const item of questions) {
    const record =
      typeof item === "string"
        ? { question: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;

    const draft = normalizeQuestionDraft(record);

    if (!record || !draft) {
      continue;
    }

    if (!draft.conciseAnswer || seen.has(draft.questionIdentity)) {
      continue;
    }

    seen.add(draft.questionIdentity);
    normalized.push({
      question: draft.question,
      conciseAnswer: draft.conciseAnswer,
      proposedConceptSlugs: draft.proposedConceptSlugs,
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
}): Promise<string> {
  const { response, body } = await openRouterChatCompletion({
    apiKey: input.apiKey,
    trace: {
      operation: "generate_questions_context_summary",
      userId: input.userId,
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
}): Promise<number[]> {
  const embeddings = await requestEmbeddings({
    apiKey: input.apiKey,
    texts: [input.summary],
    failureMode: "empty",
    trace: {
      operation: "generate_questions_summary_embedding",
      userId: input.userId,
    },
  });

  return embeddings[0] ?? [];
}

async function loadGenerationNeighbors(input: {
  apiKey: string;
  summary: string;
  userId: string;
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
        AND q.user_id = qe.user_id
      WHERE qe.user_id = $2
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
      input.userId,
      resolveEmbeddingModel(),
      DEDUPE_EMBEDDING_KIND,
      DEDUPE_SOURCE_VERSION,
      GENERATION_NEIGHBOR_COUNT,
    ],
  );

  return result.rows.map((row) => ({
    question: String(row.question ?? "").slice(0, QUESTION_TEXT_MAX_CHARS),
    conciseAnswer: String(row.concise_answer ?? "").slice(
      0,
      CONCISE_ANSWER_MAX_CHARS,
    ),
    similarity: Number((1 - Number(row.distance)).toFixed(4)),
  }));
}

async function loadExistingQuestionIdentities(userId: string): Promise<Set<string>> {
  const result = await pool.query(
    `
      SELECT q.question_slug
      FROM questions q
      WHERE q.user_id = $1
    `,
    [userId],
  );

  return new Set(
    result.rows
      .map((row: { question_slug?: unknown }) => String(row.question_slug ?? ""))
      .filter(Boolean),
  );
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

  const count = normalizeQuestionCount(payload.count);

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

  const context = buildContext({ scope: scope.value, files: files.value });
  const [contextSummary, existingQuestionIdentities] = await Promise.all([
    context.length <= MAX_DIRECT_GENERATION_CONTEXT_CHARS
      ? context.slice(0, MAX_SUMMARY_CHARS)
      : summarizeGenerationContext({
          apiKey,
          model,
          context,
          userId: user.id,
        }),
    loadExistingQuestionIdentities(user.id),
  ]);
  const generationNeighbors = await loadGenerationNeighbors({
    apiKey,
    summary: contextSummary,
    userId: user.id,
  });
  const questionQualityReference = getQuestionQualityReference();
  const { response, body: data } = await openRouterChatCompletion({
    apiKey,
    trace: {
      operation: "generate_questions",
      userId: user.id,
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
            "Difficulty: Mixed.",
            generationNeighbors.length > 0
              ? [
                  "Nearby already-covered questions from the knowledge base:",
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
    existingQuestionIdentities,
  ).slice(0, count);

  return NextResponse.json({
    ok: true,
    questions: generated,
  });
}
