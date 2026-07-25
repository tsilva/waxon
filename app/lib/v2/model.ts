import {
  buildOpenRouterHeaders,
  OPENROUTER_CHAT_URL,
  OPENROUTER_EMBEDDINGS_URL,
  resolveEmbeddingModel,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  DEFAULT_OPENROUTER_CHAT_MODEL,
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
} from "@/shared/openrouter-config.mts";
import { extractJsonObject } from "@/shared/json-object.mts";
import type { V2AnswerMode, V2Grade } from "./types";

async function postOpenRouter<T>(url: string, body: unknown): Promise<T> {
  const apiKey = resolveOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("Model work is unavailable because no API key is configured.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Model request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  return JSON.parse(text) as T;
}

function chatText(body: {
  choices?: Array<{ message?: { content?: unknown } }>;
}): string {
  const content = body.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = part as { text?: unknown };
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }

  return "";
}

function parseObject(text: string): Record<string, unknown> {
  const extracted = extractJsonObject(text);

  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
    throw new Error("Model returned invalid structured output.");
  }

  return extracted as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 32)
    : [];
}

export async function embedTexts(input: {
  userId: string;
  texts: string[];
}): Promise<{ model: string; embeddings: number[][] }> {
  const model = resolveEmbeddingModel();
  const body = await postOpenRouter<{
    data?: Array<{ embedding?: unknown }>;
  }>(OPENROUTER_EMBEDDINGS_URL, {
    model,
    input: input.texts,
    encoding_format: "float",
    user: input.userId,
  });
  const embeddings = (body.data ?? []).map((item) => {
    if (
      !Array.isArray(item.embedding) ||
      item.embedding.length !== 3_072 ||
      !item.embedding.every(
        (component) =>
          typeof component === "number" && Number.isFinite(component),
      )
    ) {
      throw new Error("Embedding response has an invalid shape.");
    }

    return item.embedding as number[];
  });

  if (embeddings.length !== input.texts.length) {
    throw new Error("Embedding response count does not match its input.");
  }

  return { model, embeddings };
}

export async function evaluateRecall(input: {
  userId: string;
  prompt: string;
  referenceAnswer: string;
  answer: string;
  answerMode: V2AnswerMode;
}): Promise<{
  grade: V2Grade;
  feedback: string;
  expectedAnswer: string;
  coveredPoints: string[];
  missingPoints: string[];
  demonstratedGap: string | null;
  confidence: number;
}> {
  const model =
    resolveOpenRouterModel({
      variable: "LLM_EVALUATION_MODEL",
      fallback: DEFAULT_OPENROUTER_EVALUATION_MODEL,
    }) ?? DEFAULT_OPENROUTER_EVALUATION_MODEL;
  const response = await postOpenRouter<{
    choices?: Array<{ message?: { content?: unknown } }>;
  }>(OPENROUTER_CHAT_URL, {
    model,
    temperature: 0,
    max_tokens: 900,
    response_format: { type: "json_object" },
    user: input.userId,
    messages: [
      {
        role: "system",
        content:
          "Evaluate free recall against the stored answer. Return JSON only with grade (again|hard|good|easy), feedback, expectedAnswer, coveredPoints, missingPoints, demonstratedGap, confidence. Use again for forgotten or substantially wrong, hard for fragile/partial recall, good for correct recall with minor omissions, easy only for complete effortless recall. Never reward fluent unsupported claims.",
      },
      {
        role: "user",
        content: JSON.stringify(input),
      },
    ],
  });
  const parsed = parseObject(chatText(response));
  const candidate = parsed.grade;
  const grade: V2Grade =
    candidate === "again" ||
    candidate === "hard" ||
    candidate === "good" ||
    candidate === "easy"
      ? candidate
      : "again";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

  return {
    grade,
    feedback:
      typeof parsed.feedback === "string" && parsed.feedback.trim()
        ? parsed.feedback.trim().slice(0, 8_000)
        : "Compare your answer with the reference answer.",
    expectedAnswer:
      typeof parsed.expectedAnswer === "string" &&
      parsed.expectedAnswer.trim()
        ? parsed.expectedAnswer.trim().slice(0, 65_536)
        : input.referenceAnswer,
    coveredPoints: asStringArray(parsed.coveredPoints),
    missingPoints: asStringArray(parsed.missingPoints),
    demonstratedGap:
      typeof parsed.demonstratedGap === "string" &&
      parsed.demonstratedGap.trim()
        ? parsed.demonstratedGap.trim().slice(0, 4_000)
        : null,
    confidence,
  };
}

export type GeneratedCoverageTarget = {
  type: string;
  statement: string;
  evidenceQuote: string;
  question: string | null;
  answer: string | null;
  displayAnswer: string | null;
  answerMode: V2AnswerMode | null;
  concepts: string[];
};

export async function analyzeSourceMaterial(input: {
  userId: string;
  title: string;
  text: string;
}): Promise<{
  targets: GeneratedCoverageTarget[];
  unresolved: string[];
}> {
  const model =
    resolveOpenRouterModel({
      variable: "LLM_LEARN_MODEL",
      fallback: DEFAULT_OPENROUTER_CHAT_MODEL,
    }) ?? DEFAULT_OPENROUTER_CHAT_MODEL;
  const response = await postOpenRouter<{
    choices?: Array<{ message?: { content?: unknown } }>;
  }>(OPENROUTER_CHAT_URL, {
    model,
    temperature: 0.1,
    max_tokens: 8_000,
    response_format: { type: "json_object" },
    user: input.userId,
    messages: [
      {
        role: "system",
        content:
          "Turn source material into an auditable coverage manifest and high-quality active-recall drafts. Return JSON only: {targets:[{type,statement,evidenceQuote,question,answer,displayAnswer,answerMode,concepts}],unresolved:[string]}. Targets must be atomic claims, distinctions, formulas, procedures, derivation steps, prerequisites, or failure modes. evidenceQuote must be an exact substring of the source. Questions must be concise, atomic, self-contained, recall-oriented, precise, and answerable only from that evidence. Do not use outside knowledge. Set question fields to null when evidence is insufficient or the target should not become a card.",
      },
      {
        role: "user",
        content: JSON.stringify({
          title: input.title,
          source: input.text.slice(0, 250_000),
        }),
      },
    ],
  });
  const parsed = parseObject(chatText(response));
  const targets = Array.isArray(parsed.targets)
    ? parsed.targets.slice(0, 200).flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return [];
        }
        const item = raw as Record<string, unknown>;
        const type =
          typeof item.type === "string" ? item.type.trim().slice(0, 80) : "";
        const statement =
          typeof item.statement === "string"
            ? item.statement.trim().slice(0, 4_000)
            : "";
        const evidenceQuote =
          typeof item.evidenceQuote === "string"
            ? item.evidenceQuote.trim().slice(0, 16_000)
            : "";

        if (!type || !statement || !evidenceQuote) {
          return [];
        }

        const mode = item.answerMode;
        return [
          {
            type,
            statement,
            evidenceQuote,
            question:
              typeof item.question === "string" && item.question.trim()
                ? item.question.trim().slice(0, 16_384)
                : null,
            answer:
              typeof item.answer === "string" && item.answer.trim()
                ? item.answer.trim().slice(0, 65_536)
                : null,
            displayAnswer:
              typeof item.displayAnswer === "string" &&
              item.displayAnswer.trim()
                ? item.displayAnswer.trim().slice(0, 8_000)
                : null,
            answerMode:
              mode === "exact" || mode === "semantic" || mode === "rubric"
                ? mode
                : null,
            concepts: asStringArray(item.concepts).slice(0, 8),
          } satisfies GeneratedCoverageTarget,
        ];
      })
    : [];

  return {
    targets,
    unresolved: asStringArray(parsed.unresolved).slice(0, 200),
  };
}

export async function generateRepairQuestion(input: {
  userId: string;
  parentPrompt: string;
  demonstratedGap: string;
  evidence: string;
}): Promise<{
  question: string;
  answer: string;
  displayAnswer: string;
  target: string;
  answerMode: V2AnswerMode;
} | null> {
  const model =
    resolveOpenRouterModel({
      variable: "LLM_LEARN_MODEL",
      fallback: DEFAULT_OPENROUTER_CHAT_MODEL,
    }) ?? DEFAULT_OPENROUTER_CHAT_MODEL;
  const response = await postOpenRouter<{
    choices?: Array<{ message?: { content?: unknown } }>;
  }>(OPENROUTER_CHAT_URL, {
    model,
    temperature: 0,
    max_tokens: 1_200,
    response_format: { type: "json_object" },
    user: input.userId,
    messages: [
      {
        role: "system",
        content:
          "Create at most one repair question only for the demonstrated gap. Return JSON {question,answer,displayAnswer,target,answerMode} or {question:null}. Do not ask adjacent, prerequisite, already-covered, or boundary-case knowledge. Do not reveal the answer in the question. Use only the supplied evidence.",
      },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  const parsed = parseObject(chatText(response));

  if (
    typeof parsed.question !== "string" ||
    typeof parsed.answer !== "string" ||
    typeof parsed.target !== "string"
  ) {
    return null;
  }
  const mode = parsed.answerMode;

  return {
    question: parsed.question.trim().slice(0, 16_384),
    answer: parsed.answer.trim().slice(0, 65_536),
    displayAnswer:
      typeof parsed.displayAnswer === "string" && parsed.displayAnswer.trim()
        ? parsed.displayAnswer.trim().slice(0, 8_000)
        : parsed.answer.trim().slice(0, 8_000),
    target: parsed.target.trim().slice(0, 4_000),
    answerMode:
      mode === "exact" || mode === "rubric" ? mode : "semantic",
  };
}
