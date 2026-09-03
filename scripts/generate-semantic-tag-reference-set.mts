import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

import { activeEmbeddingSpace } from "../app/lib/v2/embeddingSpaces.ts";
import {
  buildOpenRouterHeaders,
  DEFAULT_OPENROUTER_EVALUATION_MODEL,
  OPENROUTER_CHAT_URL,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
} from "../shared/openrouter-config.mts";

const REFERENCE_PATH = new URL(
  "../reference/semantic-tag-reference-set.json",
  import.meta.url,
);
const BATCH_SIZE = 15;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const suppliedEnvFile = flag("--env-file");
if (suppliedEnvFile) process.loadEnvFile(suppliedEnvFile);
for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Deployment environments may provide variables directly.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}
const apiKey = resolveOpenRouterApiKey();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");
const referenceApiKey = apiKey;
const model =
  resolveOpenRouterModel({
    variable: "LLM_EVALUATION_MODEL",
    fallback: DEFAULT_OPENROUTER_EVALUATION_MODEL,
  }) ?? DEFAULT_OPENROUTER_EVALUATION_MODEL;
const requestedLearnerId = flag("--user-id");
const shouldWrite = process.argv.includes("--write");
const pool = new pg.Pool({ connectionString });

type Question = {
  id: string;
  prompt: string;
  answerStandard: string;
};
type Tag = {
  id: string;
  label: string;
  aliases: string[];
  description: string;
};
type Judgment = {
  question: number;
  relevantTagIndexes: number[];
};

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
  questionCount: number,
  tagCount: number,
): Judgment[] {
  const judgments =
    value && typeof value === "object"
      ? (value as { judgments?: unknown }).judgments
      : undefined;
  if (!Array.isArray(judgments) || judgments.length !== questionCount) {
    throw new Error("Reference response omitted Questions.");
  }
  const normalized = judgments.map((judgment) => {
    const candidate = judgment as Partial<Judgment>;
    if (
      !Number.isInteger(candidate.question) ||
      Number(candidate.question) < 0 ||
      Number(candidate.question) >= questionCount ||
      !Array.isArray(candidate.relevantTagIndexes) ||
      candidate.relevantTagIndexes.length > 3 ||
      candidate.relevantTagIndexes.some(
        (index) =>
          !Number.isInteger(index) || Number(index) < 0 || Number(index) >= tagCount,
      )
    ) {
      throw new Error("Reference response contained an invalid judgment.");
    }
    return {
      question: Number(candidate.question),
      relevantTagIndexes: [
        ...new Set(candidate.relevantTagIndexes.map(Number)),
      ],
    };
  });
  if (new Set(normalized.map(({ question }) => question)).size !== questionCount) {
    throw new Error("Reference response duplicated Questions.");
  }
  return normalized.sort((left, right) => left.question - right.question);
}

async function requestJudgments(
  questions: readonly Question[],
  tags: readonly Tag[],
): Promise<Judgment[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: buildOpenRouterHeaders(referenceApiKey),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 6_000,
          provider: { require_parameters: true },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "semantic_tag_reference_set",
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
                        relevantTagIndexes: {
                          type: "array",
                          maxItems: 3,
                          items: { type: "integer", minimum: 0, maximum: 10_000 },
                        },
                      },
                      required: ["question", "relevantTagIndexes"],
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
                "Create the ideal visible Tag set for each Question. A Tag must describe subject matter materially relevant to the Question's single Recall Target. Use the Prompt and Answer Standard to infer that target. Select no more than three Tags, ordered most relevant first. Prefer the most specific useful Tags. Include a broader Tag only when a learner would reasonably practice this exact Question through it. Reject lifecycle, difficulty, incidental mentions, neighboring fields, and concepts present only as optional background. Select only indexes from the supplied Tag catalog. Return one judgment for every Question. An empty set is valid when the catalog has no relevant Tag.",
            },
            {
              role: "user",
              content: JSON.stringify({
                tags: tags.map((tag, index) => ({
                  index,
                  label: tag.label,
                  aliases: tag.aliases,
                  description: tag.description,
                })),
                questions: questions.map((question, index) => ({
                  index,
                  prompt: question.prompt,
                  answerStandard: question.answerStandard,
                })),
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Reference request failed (${response.status}): ${text.slice(0, 300)}`,
        );
      }
      const body = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      return validateJudgments(
        JSON.parse(chatText(body)),
        questions.length,
        tags.length,
      );
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
  }
  throw lastError;
}

try {
  const learners = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM waxon_v2.questions ORDER BY user_id`,
  );
  const learnerId = requestedLearnerId ??
    (learners.rows.length === 1 ? learners.rows[0]?.user_id : undefined);
  if (!learnerId) {
    throw new Error("Pass --user-id when the database contains multiple learners.");
  }
  if (!learners.rows.some(({ user_id }) => user_id === learnerId)) {
    throw new Error("The requested learner has no Questions.");
  }

  const [questionResult, tagResult] = await Promise.all([
    pool.query<{
      id: string;
      prompt: string;
      reference_answer: string;
    }>(
      `SELECT id, prompt, reference_answer
         FROM waxon_v2.questions
        WHERE user_id = $1
          AND lifecycle::text IN ('active', 'flagged', 'archived')
        ORDER BY id`,
      [learnerId],
    ),
    pool.query<{
      id: string;
      label: string;
      aliases: string[];
      scope_note: string;
    }>(
      `SELECT id, label, aliases, scope_note
         FROM waxon_v2.tags
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY label, id`,
      [learnerId],
    ),
  ]);
  const questions: Question[] = questionResult.rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    answerStandard: row.reference_answer,
  }));
  const tags: Tag[] = tagResult.rows.map((row) => ({
    id: row.id,
    label: row.label,
    aliases: row.aliases,
    description: row.scope_note,
  }));
  if (questions.length === 0 || tags.length === 0) {
    throw new Error("Reference generation requires Questions and active Tags.");
  }

  const entries: Array<{ questionId: string; expectedTagIds: string[] }> = [];
  for (let offset = 0; offset < questions.length; offset += BATCH_SIZE) {
    const batch = questions.slice(offset, offset + BATCH_SIZE);
    const judgments = await requestJudgments(batch, tags);
    entries.push(
      ...judgments.map((judgment) => ({
        questionId: batch[judgment.question]!.id,
        expectedTagIds: judgment.relevantTagIndexes.map(
          (tagIndex) => tags[tagIndex]!.id,
        ),
      })),
    );
    console.log(`Judged ${Math.min(offset + batch.length, questions.length)}/${questions.length} Questions.`);
  }

  const existing = JSON.parse(await readFile(REFERENCE_PATH, "utf8")) as {
    questions?: Array<{ questionId: string; expectedTagIds: string[] }>;
  };
  const currentQuestionIds = new Set(questions.map(({ id }) => id));
  const retained = (existing.questions ?? []).filter(
    ({ questionId }) => !currentQuestionIds.has(questionId),
  );
  const space = activeEmbeddingSpace();
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model,
    embeddingSpace: space.key,
    tagCatalogFingerprint: createHash("sha256")
      .update(JSON.stringify(tags))
      .digest("hex"),
    questions: [...retained, ...entries].sort((left, right) =>
      left.questionId.localeCompare(right.questionId),
    ),
  };
  if (shouldWrite) {
    await writeFile(REFERENCE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      model,
      questions: questions.length,
      tags: tags.length,
      relevantSelections: entries.reduce(
        (count, entry) => count + entry.expectedTagIds.length,
        0,
      ),
      wroteReferenceSet: shouldWrite,
    }),
  );
} finally {
  await pool.end();
}
