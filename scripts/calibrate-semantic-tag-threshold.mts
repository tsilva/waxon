import pg from "pg";

import {
  buildOpenRouterHeaders,
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
  OPENROUTER_CHAT_URL,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
} from "../shared/openrouter-config.mts";
import { activeEmbeddingSpace } from "../app/lib/v2/embeddingSpaces.ts";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and Vercel may provide the environment directly.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}
const apiKey = resolveOpenRouterApiKey();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");

const model =
  resolveOpenRouterModel({
    variable: "LLM_EVALUATION_MODEL",
    fallback: DEFAULT_OPENROUTER_EVALUATION_MODEL,
  }) ?? DEFAULT_OPENROUTER_EVALUATION_MODEL;
const space = activeEmbeddingSpace();
const pool = new pg.Pool({ connectionString });

type CandidateRow = {
  question_index: number;
  prompt: string;
  reference_answer: string;
  candidate_index: number;
  label: string;
  aliases: string[];
  description: string;
  similarity: number | string;
};

type Candidate = {
  index: number;
  label: string;
  aliases: string[];
  description: string;
  similarity: number;
};

type EvaluationQuestion = {
  id: number;
  prompt: string;
  answerStandard: string;
  candidates: Candidate[];
};

type Judgment = { question: number; relevant: number[] };

function chatText(body: {
  choices?: Array<{ message?: { content?: unknown } }>;
}): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = part as { text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function validateJudgments(value: unknown, questionCount: number): Judgment[] {
  if (!value || typeof value !== "object") {
    throw new Error("Calibration response was not an object.");
  }
  const judgments = (value as { judgments?: unknown }).judgments;
  if (!Array.isArray(judgments) || judgments.length !== questionCount) {
    throw new Error("Calibration response omitted Questions.");
  }
  const normalized = judgments.map((judgment) => {
    if (!judgment || typeof judgment !== "object") {
      throw new Error("Calibration response contained a malformed judgment.");
    }
    const { question, relevant } = judgment as {
      question?: unknown;
      relevant?: unknown;
    };
    if (
      !Number.isInteger(question) ||
      Number(question) < 0 ||
      Number(question) >= questionCount ||
      !Array.isArray(relevant) ||
      relevant.some(
        (index) => !Number.isInteger(index) || Number(index) < 0 || Number(index) > 2,
      )
    ) {
      throw new Error("Calibration response contained an invalid judgment.");
    }
    return {
      question: Number(question),
      relevant: [...new Set(relevant.map(Number))],
    };
  });
  if (new Set(normalized.map(({ question }) => question)).size !== questionCount) {
    throw new Error("Calibration response duplicated Questions.");
  }
  return normalized.sort((left, right) => left.question - right.question);
}

function metrics(
  questions: readonly EvaluationQuestion[],
  judgments: readonly Judgment[],
  threshold: number,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let questionsWithTags = 0;
  for (const [questionIndex, question] of questions.entries()) {
    const relevant = new Set(judgments[questionIndex]!.relevant);
    const shown = question.candidates.filter(
      (candidate) => candidate.similarity >= threshold,
    );
    if (shown.length > 0) questionsWithTags += 1;
    for (const candidate of question.candidates) {
      const isShown = candidate.similarity >= threshold;
      const isRelevant = relevant.has(candidate.index);
      if (isShown && isRelevant) truePositive += 1;
      else if (isShown) falsePositive += 1;
      else if (isRelevant) falseNegative += 1;
    }
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return {
    threshold,
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall),
    shown: truePositive + falsePositive,
    questionsWithTags,
    truePositive,
    falsePositive,
    falseNegative,
  };
}

try {
  const result = await pool.query<CandidateRow>(
    `WITH questions AS (
       SELECT question.user_id, question.id, question.prompt, question.reference_answer,
              embedding.embedding,
              row_number() OVER (ORDER BY question.id)::int - 1 AS question_index
         FROM waxon_v2.questions question
         JOIN waxon_v2.question_embeddings embedding
           ON embedding.user_id = question.user_id
          AND embedding.question_id = question.id
          AND embedding.space_id = $1
     ), ranked AS (
       SELECT question.question_index, question.prompt, question.reference_answer,
              tag.label, tag.aliases, tag.scope_note AS description,
              1 - (tag_embedding.embedding <=> question.embedding) AS similarity,
              row_number() OVER (
                PARTITION BY question.id
                ORDER BY tag_embedding.embedding <=> question.embedding, tag.id
              )::int - 1 AS candidate_index
         FROM questions question
         JOIN waxon_v2.tag_embeddings tag_embedding
           ON tag_embedding.user_id = question.user_id
          AND tag_embedding.space_id = $1
         JOIN waxon_v2.tags tag
           ON tag.user_id = tag_embedding.user_id
          AND tag.id = tag_embedding.tag_id
          AND tag.deleted_at IS NULL
     )
     SELECT * FROM ranked
      WHERE candidate_index < 3
      ORDER BY question_index, candidate_index`,
    [space.id],
  );
  const grouped = Map.groupBy(result.rows, (row) => row.question_index);
  const questions = [...grouped.entries()].map(([id, rows]) => ({
    id,
    prompt: rows[0]!.prompt,
    answerStandard: rows[0]!.reference_answer,
    candidates: rows.map((row) => ({
      index: row.candidate_index,
      label: row.label,
      aliases: row.aliases,
      description: row.description,
      similarity: Number(row.similarity),
    })),
  }));
  if (questions.length === 0 || questions.some(({ candidates }) => candidates.length !== 3)) {
    throw new Error("Calibration requires three candidates for every embedded Question.");
  }

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 12_000,
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "semantic_tag_calibration",
          strict: true,
          schema: {
            type: "object",
            properties: {
              judgments: {
                type: "array",
                minItems: questions.length,
                maxItems: questions.length,
                items: {
                  type: "object",
                  properties: {
                    question: { type: "integer", minimum: 0 },
                    relevant: {
                      type: "array",
                      uniqueItems: true,
                      items: { type: "integer", minimum: 0, maximum: 2 },
                    },
                  },
                  required: ["question", "relevant"],
                  additionalProperties: false,
                },
              },
            },
            required: ["judgments"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Judge whether each candidate Tag describes subject matter materially relevant to the Question's Recall Target. Use the Prompt and Answer Standard to infer that target. A Tag is relevant when a learner could reasonably drill this Question through that Tag. Reject lifecycle, difficulty, incidental mentions, broad neighboring fields, and concepts present only in optional background. Evaluate each candidate independently. Return one judgment for every Question and only candidate indexes 0, 1, or 2.",
        },
        { role: "user", content: JSON.stringify(questions) },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Calibration request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const body = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const judgments = validateJudgments(
    JSON.parse(chatText(body)),
    questions.length,
  );
  const thresholds = [
    ...new Set([
      0,
      ...questions.flatMap(({ candidates }) =>
        candidates.map(({ similarity }) => similarity),
      ),
    ]),
  ].sort((left, right) => left - right);
  const allMetrics = thresholds.map((threshold) =>
    metrics(questions, judgments, threshold),
  );
  const precisionFirst = allMetrics
    .filter(({ precision }) => precision >= 0.85)
    .sort(
      (left, right) =>
        right.recall - left.recall || left.threshold - right.threshold,
    )[0];
  const bestF1 = [...allMetrics].sort(
    (left, right) => right.f1 - left.f1 || right.precision - left.precision,
  )[0];
  const checkpoints = [0.45, 0.475, 0.5, 0.525, 0.55].map((threshold) =>
    metrics(questions, judgments, threshold),
  );
  console.log(
    JSON.stringify(
      {
        space: space.key,
        model,
        questions: questions.length,
        judgedCandidates: questions.length * 3,
        relevantCandidates: judgments.reduce(
          (count, judgment) => count + judgment.relevant.length,
          0,
        ),
        precisionFirst,
        bestF1,
        checkpoints,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
