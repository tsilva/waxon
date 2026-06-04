import { Pool, neonConfig } from "@neondatabase/serverless";
import { createHash } from "node:crypto";

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
const DEFAULT_KIND = "dedupe_v1";
const DEFAULT_SOURCE_VERSION = 1;
const DEFAULT_BATCH_SIZE = 32;

function parseArgs(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    force: false,
    kind: DEFAULT_KIND,
    model: DEFAULT_MODEL,
    sourceVersion: DEFAULT_SOURCE_VERSION,
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

    if (arg === "--kind") {
      options.kind = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--source-version") {
      options.sourceVersion = Number(argv[index + 1] ?? "");
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
  options.kind = options.kind.trim();

  if (!options.model) {
    throw new Error("--model must not be empty");
  }

  if (!options.kind) {
    throw new Error("--kind must not be empty");
  }

  if (!Number.isInteger(options.sourceVersion) || options.sourceVersion < 1) {
    throw new Error("--source-version must be a positive integer");
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

function normalizeEmbeddingText(value) {
  return value.trim().replace(/\s+/g, " ");
}

function buildEmbeddingSource(row, kind, sourceVersion) {
  if (kind === "question_only") {
    return [
      `version: ${sourceVersion}`,
      "kind: question_only",
      `Question: ${normalizeEmbeddingText(row.question)}`,
    ].join("\n");
  }

  if (kind === "dedupe_v1") {
    if (!row.concise_answer?.trim()) {
      throw new Error(
        `Question is missing concise_answer for dedupe_v1: ${row.question}`,
      );
    }

    return [
      `version: ${sourceVersion}`,
      "kind: dedupe_v1",
      `Question: ${normalizeEmbeddingText(row.question)}`,
      `Expected answer: ${normalizeEmbeddingText(row.concise_answer)}`,
    ].join("\n");
  }

  throw new Error(`Unsupported embedding kind: ${kind}`);
}

function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
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

async function loadQuestions(pool, options) {
  const result = await pool.query(
    `
      SELECT
        q.deck_id,
        q.question,
        q.concise_answer,
        qe.source_hash AS existing_source_hash
      FROM questions q
      LEFT JOIN question_embeddings qe
        ON qe.question = q.question
       AND qe.deck_id = q.deck_id
       AND qe.embedding_model = $1
       AND qe.embedding_kind = $2
       AND qe.source_version = $3
       AND qe.is_current = true
      ORDER BY q.created_at ASC, q.question ASC
    `,
    [options.model, options.kind, options.sourceVersion],
  );

  return result.rows
    .map((row) => {
      const source = buildEmbeddingSource(row, options.kind, options.sourceVersion);

      return {
        ...row,
        source,
        source_hash: sourceHash(source),
      };
    })
    .filter(
      (row) =>
        options.force || String(row.existing_source_hash ?? "") !== row.source_hash,
    );
}

async function saveEmbeddings(pool, rows, options) {
  const now = Date.now();

  for (const row of rows) {
    await pool.query(
      `
        INSERT INTO question_embeddings (
          deck_id,
          question,
          embedding_model,
          embedding_kind,
          source_version,
          source_hash,
          is_current,
          embedding,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, $7::vector, $8, $8)
        ON CONFLICT (
          deck_id,
          question,
          embedding_model,
          embedding_kind,
          source_version
        )
        DO UPDATE SET
          embedding = excluded.embedding,
          source_hash = excluded.source_hash,
          is_current = true,
          updated_at = excluded.updated_at
      `,
      [
        row.deck_id,
        row.question,
        options.model,
        options.kind,
        options.sourceVersion,
        row.source_hash,
        vectorLiteral(row.embedding),
        now,
      ],
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
  const pool = new Pool({ connectionString });

  try {
    const questions = await loadQuestions(pool, options);

    if (questions.length === 0) {
      console.log(`No questions need embeddings for ${options.model}.`);
      return;
    }

    console.log(
      `Embedding ${questions.length} ${options.kind} sources with ${options.model} in batches of ${options.batchSize}.`,
    );

    let saved = 0;

    for (const batch of chunks(questions, options.batchSize)) {
      const embeddings = await fetchEmbeddings(
        batch.map((row) => row.source),
        options.model,
        apiKey,
      );
      await saveEmbeddings(
        pool,
        batch.map((row, index) => ({
          ...row,
          embedding: embeddings[index],
        })),
        options,
      );
      saved += batch.length;
      console.log(`Saved ${saved}/${questions.length}`);
    }

    console.log(
      `Saved ${saved} ${options.kind} question embeddings for ${options.model}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
