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

const OPENROUTER_EMBEDDINGS_URL =
  "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "google/gemini-embedding-2";
const DEFAULT_BATCH_SIZE = 32;

function parseArgs(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    force: false,
    model: DEFAULT_MODEL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--model") {
      options.model = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--batch-size") {
      options.batchSize = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.model = options.model.trim();

  if (!options.model) {
    throw new Error("--model must not be empty");
  }

  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 128
  ) {
    throw new Error("--batch-size must be an integer from 1 to 128");
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

function vectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function chunks(items, size) {
  const result = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

async function fetchEmbeddings(input, model, apiKey) {
  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "waxon",
    },
    body: JSON.stringify({
      model,
      input,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter embedding request failed: ${response.status} ${
        response.statusText
      } ${errorText.slice(0, 500)}`.trim(),
    );
  }

  const body = await response.json();

  if (!Array.isArray(body.data) || body.data.length !== input.length) {
    throw new Error(
      `OpenRouter returned ${body.data?.length ?? "no"} embeddings for ${
        input.length
      } inputs`,
    );
  }

  return body.data.map((item, index) => {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error(`Embedding ${index} is missing or empty`);
    }

    const embedding = item.embedding.map((component) => Number(component));

    if (embedding.some((component) => !Number.isFinite(component))) {
      throw new Error(`Embedding ${index} contains a non-finite value`);
    }

    return embedding;
  });
}

async function loadQuestions(pool, model, force) {
  const result = await pool.query(
    `
      SELECT q.question
      FROM questions q
      WHERE
        $2::boolean
        OR NOT EXISTS (
          SELECT 1
          FROM question_embeddings qe
          WHERE qe.question = q.question
            AND qe.embedding_model = $1
        )
      ORDER BY q.created_at ASC, q.question ASC
    `,
    [model, force],
  );

  return result.rows.map((row) => row.question);
}

async function saveEmbeddings(pool, rows, model) {
  const now = Date.now();

  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO question_embeddings (
          question,
          embedding_model,
          embedding,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3::vector, $4, $4)
        ON CONFLICT (question, embedding_model)
        DO UPDATE SET
          embedding = excluded.embedding,
          updated_at = excluded.updated_at
      `,
      [row.question, model, vectorLiteral(row.embedding), now],
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
  const pool = new Pool({ connectionString });

  try {
    const questions = await loadQuestions(pool, options.model, options.force);

    if (questions.length === 0) {
      console.log(`No questions need embeddings for ${options.model}.`);
      return;
    }

    console.log(
      `Embedding ${questions.length} questions with ${options.model} in batches of ${options.batchSize}.`,
    );

    let saved = 0;

    for (const batch of chunks(questions, options.batchSize)) {
      const embeddings = await fetchEmbeddings(batch, options.model, apiKey);
      await saveEmbeddings(
        pool,
        batch.map((question, index) => ({
          question,
          embedding: embeddings[index],
        })),
        options.model,
      );
      saved += batch.length;
      console.log(`Saved ${saved}/${questions.length}`);
    }

    console.log(`Saved ${saved} question embeddings for ${options.model}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
