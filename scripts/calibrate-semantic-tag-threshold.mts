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
const calibrationApiKey = apiKey;

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
  semantic_rank: number;
  label: string;
  aliases: string[];
  description: string;
  similarity: number | string;
  lexical_match: boolean;
};

type Candidate = {
  index: number;
  label: string;
  aliases: string[];
  description: string;
  similarity: number;
  lexicalMatch: boolean;
  semanticRank: number;
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

function validateJudgments(
  value: unknown,
  questions: readonly EvaluationQuestion[],
): Judgment[] {
  if (!value || typeof value !== "object") {
    throw new Error("Calibration response was not an object.");
  }
  const judgments = (value as { judgments?: unknown }).judgments;
  if (!Array.isArray(judgments) || judgments.length !== questions.length) {
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
      Number(question) >= questions.length ||
      !Array.isArray(relevant) ||
      relevant.some(
        (index) =>
          !Number.isInteger(index) ||
          Number(index) < 0 ||
          Number(index) >= questions[Number(question)]!.candidates.length,
      )
    ) {
      throw new Error("Calibration response contained an invalid judgment.");
    }
    return {
      question: Number(question),
      relevant: [...new Set(relevant.map(Number))],
    };
  });
  if (new Set(normalized.map(({ question }) => question)).size !== questions.length) {
    throw new Error("Calibration response duplicated Questions.");
  }
  return normalized.sort((left, right) => left.question - right.question);
}

function metrics(
  questions: readonly EvaluationQuestion[],
  judgments: readonly Judgment[],
  semanticThreshold: number,
  lexicalRescueFloor = 0.4,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let questionsWithTags = 0;
  let literalMatches = 0;
  let literalSelections = 0;
  let lexicalRescues = 0;
  let semanticOnlySelections = 0;
  let rejectedLowSimilarityMentions = 0;
  for (const [questionIndex, question] of questions.entries()) {
    const relevant = new Set(judgments[questionIndex]!.relevant);
    const shown = question.candidates
      .filter(
        (candidate) =>
          candidate.similarity >= semanticThreshold ||
          (candidate.lexicalMatch && candidate.similarity >= lexicalRescueFloor),
      )
      .sort(
        (left, right) =>
          Number(
            right.lexicalMatch && right.similarity >= lexicalRescueFloor,
          ) -
            Number(left.lexicalMatch && left.similarity >= lexicalRescueFloor) ||
          right.similarity - left.similarity ||
          left.label.localeCompare(right.label),
      )
      .slice(0, 3);
    const shownIndexes = new Set(shown.map(({ index }) => index));
    if (shown.length > 0) questionsWithTags += 1;
    literalMatches += question.candidates.filter(
      ({ lexicalMatch }) => lexicalMatch,
    ).length;
    rejectedLowSimilarityMentions += question.candidates.filter(
      (candidate) =>
        candidate.lexicalMatch && candidate.similarity < lexicalRescueFloor,
    ).length;
    literalSelections += shown.filter(({ lexicalMatch }) => lexicalMatch).length;
    lexicalRescues += shown.filter(
      (candidate) =>
        candidate.lexicalMatch && candidate.similarity < semanticThreshold,
    ).length;
    semanticOnlySelections += shown.filter(
      ({ lexicalMatch }) => !lexicalMatch,
    ).length;
    for (const candidate of question.candidates) {
      const isShown = shownIndexes.has(candidate.index);
      const isRelevant = relevant.has(candidate.index);
      if (isShown && isRelevant) truePositive += 1;
      else if (isShown) falsePositive += 1;
      else if (isRelevant) falseNegative += 1;
    }
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return {
    semanticThreshold,
    lexicalRescueFloor,
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall),
    shown: truePositive + falsePositive,
    questionsWithTags,
    truePositive,
    falsePositive,
    falseNegative,
    literalMatches,
    literalSelections,
    lexicalRescues,
    semanticOnlySelections,
    rejectedLowSimilarityMentions,
  };
}

async function requestJudgments(
  questions: readonly EvaluationQuestion[],
): Promise<Judgment[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: buildOpenRouterHeaders(calibrationApiKey),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 4_000,
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
                    items: {
                      type: "object",
                      properties: {
                        question: { type: "integer", minimum: 0 },
                        relevant: {
                          type: "array",
                          items: {
                            type: "integer",
                            minimum: 0,
                            maximum: 10_000,
                          },
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
                "Judge whether each candidate Tag describes subject matter materially relevant to the Question's Recall Target. Use the Prompt and Answer Standard to infer that target. A Tag is relevant when a learner could reasonably drill this Question through that Tag. Reject lifecycle, difficulty, incidental mentions, broad neighboring fields, and concepts present only in optional background. Evaluate each candidate independently. Return one judgment for every Question and use only candidate indexes present on that Question.",
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
      return validateJudgments(JSON.parse(chatText(body)), questions);
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
  }
  throw lastError;
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
    ), scored AS (
       SELECT question.question_index, question.prompt, question.reference_answer,
              tag.label, tag.aliases, tag.scope_note AS description,
              1 - (tag_embedding.embedding <=> question.embedding) AS similarity,
              row_number() OVER (
                PARTITION BY question.id
                ORDER BY tag_embedding.embedding <=> question.embedding, tag.id
              )::int - 1 AS semantic_rank,
              EXISTS (
                SELECT 1
                  FROM unnest(array_prepend(tag.label, tag.aliases)) AS term(value)
                 WHERE to_tsvector('simple', question.prompt)
                       @@ phraseto_tsquery('simple', term.value)
              ) AS lexical_match
         FROM questions question
         JOIN waxon_v2.tag_embeddings tag_embedding
           ON tag_embedding.user_id = question.user_id
          AND tag_embedding.space_id = $1
         JOIN waxon_v2.tags tag
           ON tag.user_id = tag_embedding.user_id
          AND tag.id = tag_embedding.tag_id
          AND tag.deleted_at IS NULL
     ), candidates AS (
       SELECT *, row_number() OVER (
         PARTITION BY question_index ORDER BY semantic_rank
       )::int - 1 AS candidate_index
         FROM scored
        WHERE semantic_rank < 3 OR lexical_match
     )
     SELECT * FROM candidates
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
      lexicalMatch: row.lexical_match,
      semanticRank: row.semantic_rank,
    })),
  }));
  if (questions.length === 0 || questions.some(({ candidates }) => candidates.length < 3)) {
    throw new Error("Calibration requires at least three candidates for every embedded Question.");
  }

  const judgments: Judgment[] = [];
  const calibrationBatchSize = 30;
  for (let offset = 0; offset < questions.length; offset += calibrationBatchSize) {
    const batch = questions.slice(offset, offset + calibrationBatchSize).map(
      (question, index) => ({ ...question, id: index }),
    );
    const batchJudgments = await requestJudgments(batch);
    judgments.push(
      ...batchJudgments.map((judgment) => ({
        ...judgment,
        question: judgment.question + offset,
      })),
    );
  }
  const thresholds = [
    ...new Set([
      0,
      ...questions.flatMap(({ candidates }) =>
        candidates.map(({ similarity }) => similarity),
      ),
    ]),
  ].sort((left, right) => left - right);
  const allMetrics = thresholds.map((threshold) =>
    metrics(questions, judgments, threshold, 0.4),
  );
  const precisionFirst = allMetrics
    .filter(({ precision }) => precision >= 0.85)
    .sort(
      (left, right) =>
        right.recall - left.recall ||
        left.semanticThreshold - right.semanticThreshold,
    )[0];
  const bestF1 = [...allMetrics].sort(
    (left, right) => right.f1 - left.f1 || right.precision - left.precision,
  )[0];
  const checkpoints = [0.45, 0.475, 0.5, 0.51, 0.525, 0.55].map((threshold) =>
    metrics(questions, judgments, threshold, 0.4),
  );
  console.log(
    JSON.stringify(
      {
        space: space.key,
        model,
        questions: questions.length,
        judgedCandidates: questions.reduce(
          (count, question) => count + question.candidates.length,
          0,
        ),
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
