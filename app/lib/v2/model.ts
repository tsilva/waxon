import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildOpenRouterHeaders,
  OPENROUTER_CHAT_URL,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
} from "../../../shared/openrouter-config.mts";
import {
  BROWSER_SMOKE_CORRECT_TOKEN,
  shouldUseBrowserAcceptanceEvaluator,
} from "../browserSmokeSupport.ts";
import { beginLlmTrace, finishLlmTrace } from "../llmTraceStore.ts";
import {
  RECALL_EVALUATION_SYSTEM_PROMPT,
  reconcileRecallEvaluation,
  type NormalizedRecallEvaluation,
  type RecallEvaluationResult,
} from "./recallEvaluation.ts";

const pointArraySchema = z
  .array(z.string().trim().min(1))
  .max(32);

const recallEvaluationResponseSchema = z.strictObject({
  recallResult: z.enum(["incorrect", "partial", "correct"]),
  coveredPoints: pointArraySchema,
  scoringIssues: pointArraySchema,
  clarifications: pointArraySchema,
  confidence: z.number().min(0).max(1),
});

export const RECALL_EVALUATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    recallResult: {
      type: "string",
      enum: ["incorrect", "partial", "correct"],
      description: "The learner's Recall Result.",
    },
    coveredPoints: {
      type: "array",
      items: { type: "string" },
      maxItems: 32,
      description: "Required recall knowledge demonstrated by the learner.",
    },
    scoringIssues: {
      type: "array",
      items: { type: "string" },
      maxItems: 32,
      description: "Only omissions or errors that prevent a Correct result.",
    },
    clarifications: {
      type: "array",
      items: { type: "string" },
      maxItems: 32,
      description: "Non-scoring precision or optional supporting details.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Diagnostic confidence only; it never changes the result.",
    },
  },
  required: [
    "recallResult",
    "coveredPoints",
    "scoringIssues",
    "clarifications",
    "confidence",
  ],
  additionalProperties: false,
} as const;

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

export function parseRecallEvaluationResponse(
  text: string,
): RecallEvaluationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Model returned malformed evaluation JSON.", {
      cause: error,
    });
  }

  const result = recallEvaluationResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Model returned an evaluation outside the required schema.");
  }
  return result.data;
}

export async function evaluateRecall(input: {
  userId: string;
  prompt: string;
  referenceAnswer: string;
  answer: string;
  browserAcceptanceEvaluationAuthorized?: boolean;
}): Promise<NormalizedRecallEvaluation> {
  if (
    shouldUseBrowserAcceptanceEvaluator({
      authorized: input.browserAcceptanceEvaluationAuthorized === true,
      learnerId: input.userId,
      prompt: input.prompt,
    })
  ) {
    const correct = input.answer.includes(BROWSER_SMOKE_CORRECT_TOKEN);
    return reconcileRecallEvaluation({
      prompt: input.prompt,
      result: {
        recallResult: correct ? "correct" : "incorrect",
        coveredPoints: correct ? ["Required token"] : [],
        scoringIssues: correct ? [] : ["Required token was missing"],
        clarifications: [],
        confidence: 1,
      },
    });
  }
  const model =
    resolveOpenRouterModel({
      variable: "LLM_EVALUATION_MODEL",
      fallback: DEFAULT_OPENROUTER_EVALUATION_MODEL,
    }) ?? DEFAULT_OPENROUTER_EVALUATION_MODEL;
  const response = await postOpenRouter<{
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: Record<string, unknown>;
  }>(OPENROUTER_CHAT_URL, {
    model,
    temperature: 0,
    max_tokens: 900,
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "recall_evaluation",
        strict: true,
        schema: RECALL_EVALUATION_JSON_SCHEMA,
      },
    },
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
  if (response.model !== model) {
    throw new Error("Model response did not identify the requested evaluator.");
  }
  const parsed = parseRecallEvaluationResponse(chatText(response));

  return reconcileRecallEvaluation({
    prompt: input.prompt,
    result: parsed,
  });
}
