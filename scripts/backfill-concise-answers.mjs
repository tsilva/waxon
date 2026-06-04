import { Pool, neonConfig } from "@neondatabase/serverless";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Missing env files are fine; CI can provide env vars directly.
  }
}

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

const DEFAULT_BATCH_SIZE = 20;

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

function requireEnv(name, fallbackName) {
  const value = process.env[name] ?? process.env[fallbackName ?? ""];

  if (!value) {
    throw new Error(
      fallbackName
        ? `${name} or ${fallbackName} is required`
        : `${name} is required`,
    );
  }

  return value;
}

function chunks(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function extractJsonObject(source) {
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

async function loadQuestions(pool, force) {
  const result = await pool.query(
    `
      SELECT deck_id, question
      FROM questions
      WHERE $1::boolean OR concise_answer = ''
      ORDER BY created_at ASC, question ASC
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
      model: process.env.LLM_MODEL ?? "openai/gpt-5.5",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: Math.min(4096, 140 * batch.length + 400),
      messages: [
        {
          role: "user",
          content: [
            "Generate concise expected answers for flashcard questions.",
            "Each answer is used for semantic duplicate detection, not as an explanation.",
            "Keep each answer factual, direct, and as short as possible while preserving the recall target.",
            "Return strict JSON: {\"answers\":[{\"question\":\"...\",\"conciseAnswer\":\"...\"}]}",
            JSON.stringify(batch.map((row) => ({ question: row.question }))),
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

  const answersByQuestion = new Map();

  for (const item of parsed.answers) {
    const question = String(item?.question ?? "").trim();
    const conciseAnswer = String(item?.conciseAnswer ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 320);

    if (question && conciseAnswer) {
      answersByQuestion.set(question, conciseAnswer);
    }
  }

  return answersByQuestion;
}

async function saveAnswers(pool, rows) {
  const now = Date.now();

  for (const row of rows) {
    await pool.query(
      `
        UPDATE questions
        SET concise_answer = $1,
            updated_at = $2
        WHERE deck_id = $3
          AND question = $4
      `,
      [row.conciseAnswer, now, row.deck_id, row.question],
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
  const pool = new Pool({ connectionString });

  try {
    const questions = await loadQuestions(pool, options.force);

    if (questions.length === 0) {
      console.log("No questions need concise answers.");
      return;
    }

    console.log(`Generating concise answers for ${questions.length} questions.`);
    let saved = 0;

    for (const batch of chunks(questions, options.batchSize)) {
      const answersByQuestion = await generateConciseAnswers(batch, apiKey);
      const rows = batch
        .map((row) => ({
          ...row,
          conciseAnswer: answersByQuestion.get(row.question) ?? "",
        }))
        .filter((row) => row.conciseAnswer);

      await saveAnswers(pool, rows);
      saved += rows.length;
      console.log(`Saved ${saved}/${questions.length}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
