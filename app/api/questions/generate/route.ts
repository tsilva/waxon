import { NextResponse } from "next/server";
import { getQuestionQualityReference } from "@/app/lib/questionQualityReference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_MODEL = process.env.LLM_MODEL || "openai/gpt-5.5";
const MAX_CONTEXT_CHARS = 32_000;
const MAX_QUESTION_COUNT = 40;

type ContextFilePayload = {
  name: string;
  content: string;
  status?: string;
};

type GeneratedQuestionPayload = {
  question: string;
  sourceLabel?: string;
  coverageLabel?: string;
};

function normalizeQuestionCount(value: unknown): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : 12;

  if (!Number.isFinite(numericValue)) {
    return 12;
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

function extractJsonObject(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(match[0]);
  }
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
    const key = question.toLowerCase();

    if (!question || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({
      question,
      sourceLabel: normalizeText(record.sourceLabel) || "OpenRouter",
      coverageLabel: normalizeText(record.coverageLabel) || question,
    });
  }

  return normalized;
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "OPENROUTER_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const payload = body as Record<string, unknown>;
  const scope = normalizeText(payload.scope);
  const files = normalizeFiles(payload.files);
  const difficulty = normalizeText(payload.difficulty) || "Mixed";
  const count = normalizeQuestionCount(payload.count);
  const existingQuestions = normalizeExistingQuestions(payload.existingQuestions);

  if (!scope && files.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Add a topic or attach context before generating." },
      { status: 400 },
    );
  }

  const context = buildContext({ scope, files });
  const questionQualityReference = getQuestionQualityReference();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "waxon",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.35,
      max_tokens: Math.min(4096, 180 * count + 700),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You generate high-quality spaced-repetition questions for a study deck.",
            "Every generated question must follow the shared question-quality reference below.",
            "Maximize coverage across the content instead of making variants of the same point.",
            "Avoid generic questions such as 'What is the key idea behind the topic?'",
            "Do not include answers, explanations, numbering, or preambles.",
            "Shared question-quality reference:",
            questionQualityReference,
          ].join("\n\n"),
        },
        {
          role: "user",
          content: [
            `Generate exactly ${count} recall questions.`,
            `Difficulty: ${difficulty}.`,
            "Return JSON only with this shape:",
            '{"questions":[{"question":"...","sourceLabel":"Prompt or filename","coverageLabel":"short covered concept"}]}',
            "Do not duplicate any existing questions or near-duplicates.",
            existingQuestions.size > 0
              ? `Existing questions to avoid:\n${Array.from(existingQuestions)
                  .slice(0, 200)
                  .join("\n")}`
              : "",
            "Content:",
            context,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `OpenRouter generation failed (${response.status}).`,
      },
      { status: 502 },
    );
  }

  const data = extractJsonObject(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;

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
