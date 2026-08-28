import { randomUUID } from "node:crypto";
import {
  buildOpenRouterHeaders,
  OPENROUTER_CHAT_URL,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
} from "../../../shared/openrouter-config.mts";
import { extractJsonObject } from "../../../shared/json-object.mts";
import {
  BROWSER_SMOKE_CORRECT_TOKEN,
  shouldUseBrowserAcceptanceEvaluator,
} from "../browserSmokeSupport.ts";
import { beginLlmTrace, finishLlmTrace } from "../llmTraceStore.ts";
import {
  RECALL_EVALUATION_SYSTEM_PROMPT,
  reconcileRecallEvaluation,
  type RecallEvaluationResult,
} from "./recallEvaluation.ts";
import type { V2Grade } from "./types.ts";

async function postOpenRouter<T extends { usage?: Record<string, unknown> }>(
  url: string,
  body: unknown,
  trace: { operation: string; model: string; question: string },
): Promise<T> {
  const apiKey = resolveOpenRouterApiKey();

  if (!apiKey) {
    throw new Error("Model work is unavailable because no API key is configured.");
  }

  const pending = beginLlmTrace({
    traceId: randomUUID(),
    operation: trace.operation,
    model: trace.model,
    question: trace.question,
    requestBody: body,
  });
  try {
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
    const parsed = JSON.parse(text) as T;
    await finishLlmTrace(pending, {
      ok: true,
      responseBody: parsed,
      usage: parsed.usage,
    });
    return parsed;
  } catch (error) {
    await finishLlmTrace(pending, { ok: false, error });
    throw error;
  }
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

export async function evaluateRecall(input: {
  userId: string;
  prompt: string;
  referenceAnswer: string;
  answer: string;
  browserAcceptanceEvaluationAuthorized?: boolean;
}): Promise<RecallEvaluationResult> {
  if (
    shouldUseBrowserAcceptanceEvaluator({
      authorized: input.browserAcceptanceEvaluationAuthorized === true,
      learnerId: input.userId,
      prompt: input.prompt,
    })
  ) {
    const correct = input.answer.includes(BROWSER_SMOKE_CORRECT_TOKEN);
    return {
      grade: correct ? "good" : "again",
      feedback: correct
        ? "The smoke-test answer matched."
        : "The smoke-test answer did not match.",
      expectedAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
      coveredPoints: correct ? ["Required token"] : [],
      missingPoints: correct ? [] : ["Required token"],
      demonstratedGap: correct ? null : "Required token was missing.",
      confidence: 1,
    };
  }
  const model =
    resolveOpenRouterModel({
      variable: "LLM_EVALUATION_MODEL",
      fallback: DEFAULT_OPENROUTER_EVALUATION_MODEL,
    }) ?? DEFAULT_OPENROUTER_EVALUATION_MODEL;
  const response = await postOpenRouter<{
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: Record<string, unknown>;
  }>(OPENROUTER_CHAT_URL, {
    model,
    temperature: 0,
    max_tokens: 900,
    response_format: { type: "json_object" },
    user: input.userId,
    messages: [
      {
        role: "system",
        content: RECALL_EVALUATION_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(input),
      },
    ],
  }, {
    operation: "evaluate_answer",
    model,
    question: input.prompt,
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

  return reconcileRecallEvaluation({
    prompt: input.prompt,
    result: {
      grade,
      feedback:
        typeof parsed.feedback === "string" && parsed.feedback.trim()
          ? parsed.feedback.trim().slice(0, 8_000)
          : "Compare your answer with the Answer Standard.",
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
      presentationDifferences: asStringArray(parsed.presentationDifferences),
    },
  });
}
