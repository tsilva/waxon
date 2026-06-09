import { Pool, neonConfig } from "@neondatabase/serverless";
import { extractJsonObject } from "./lib/json-object.mjs";
import {
  chunks,
  configureNeonWebSocket,
  createDatabasePool,
  loadLocalEnvFiles,
  logSavedProgress,
  openRouterChatModel,
  requireOpenRouterApiKey,
} from "./lib/runtime.mjs";

loadLocalEnvFiles();
configureNeonWebSocket(neonConfig);

const DEFAULT_BATCH_SIZE = 20;
const MAX_CONCISE_ANSWER_CHARS = 320;
const CONCISE_ANSWER_SYSTEM_PROMPT = [
  "Generate concise expected answers for flashcard questions.",
  "Each answer is used for semantic duplicate detection, not as an explanation.",
  "Keep each answer factual, direct, and as short as possible while preserving the recall target.",
  "Return strict JSON: {\"answers\":[{\"id\":\"...\",\"conciseAnswer\":\"...\"}]}",
].join("\n\n");

function parseArgs(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--batch-size") {
      options.batchSize = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 50
  ) {
    throw new Error("--batch-size must be an integer from 1 to 50");
  }

  return options;
}

async function loadQuestions(pool, force) {
  const result = await pool.query(
    `
      SELECT id::text, question
      FROM questions
      WHERE $1::boolean OR nullif(trim(concise_answer), '') IS NULL
      ORDER BY created_at ASC, id ASC
    `,
    [force],
  );

  return result.rows;
}

async function generateConciseAnswers(batch, apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "waxon",
    },
    body: JSON.stringify({
      model: openRouterChatModel(),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: Math.min(4096, 140 * batch.length + 400),
      messages: [
        {
          role: "system",
          content: CONCISE_ANSWER_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            "Questions:",
            JSON.stringify(
              batch.map((row) => ({
                id: row.id,
                question: row.question,
              })),
            ),
          ].join("\n\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Concise answer request failed: ${response.status} ${errorText.slice(0, 300)}`,
    );
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(typeof content === "string" ? content : "");

  if (!Array.isArray(parsed.answers)) {
    throw new Error("Model returned no answers array.");
  }

  const answersById = new Map();

  for (const item of parsed.answers) {
    const id = String(item?.id ?? "").trim();
    const conciseAnswer = String(item?.conciseAnswer ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_CONCISE_ANSWER_CHARS);

    if (id && conciseAnswer) {
      answersById.set(id, conciseAnswer);
    }
  }

  return answersById;
}

async function saveAnswers(pool, rows, force) {
  const now = Date.now();
  let saved = 0;

  for (const row of rows) {
    const result = await pool.query(
      `
        UPDATE questions
        SET concise_answer = $1,
            updated_at = $2
        WHERE id = $3::uuid
          AND ($4::boolean OR nullif(trim(concise_answer), '') IS NULL)
      `,
      [row.conciseAnswer, now, row.id, force],
    );
    saved += result.rowCount ?? 0;
  }

  return saved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireOpenRouterApiKey();
  const pool = createDatabasePool(Pool);

  try {
    const questions = await loadQuestions(pool, options.force);

    if (questions.length === 0) {
      console.log("No questions need concise answers.");
      return;
    }

    console.log(`Generating concise answers for ${questions.length} questions.`);
    let saved = 0;

    for (const batch of chunks(questions, options.batchSize)) {
      const answersById = await generateConciseAnswers(batch, apiKey);
      const rows = batch
        .map((row) => ({
          ...row,
          conciseAnswer: answersById.get(row.id) ?? "",
        }))
        .filter((row) => row.conciseAnswer);

      saved += await saveAnswers(pool, rows, options.force);
      logSavedProgress(saved, questions.length);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
