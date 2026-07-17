import { Pool, neonConfig } from "@neondatabase/serverless";
import {
  buildEmbeddingSource,
  decodeOpenRouterEmbeddings,
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  hashEmbeddingSource,
} from "../shared/embedding-contract.mjs";
import {
  chunks,
  configureNeonWebSocket,
  createDatabasePool,
  DEFAULT_EMBEDDING_MODEL,
  fetchOpenRouterJson,
  loadLocalEnvFiles,
  logSavedProgress,
  OPENROUTER_EMBEDDINGS_URL,
  requireOpenRouterApiKey,
  vectorLiteral,
} from "./lib/runtime.mjs";

loadLocalEnvFiles();
configureNeonWebSocket(neonConfig);

const DEFAULT_BATCH_SIZE = 32;

function parseArgs(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    force: false,
    kind: DEDUPE_EMBEDDING_KIND,
    model: DEFAULT_EMBEDDING_MODEL,
    sourceVersion: DEDUPE_SOURCE_VERSION,
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

async function fetchEmbeddings(input, model, apiKey) {
  const body = await fetchOpenRouterJson(OPENROUTER_EMBEDDINGS_URL, {
    apiKey,
    errorPrefix: "OpenRouter embedding request failed",
    body: {
      model,
      input,
      encoding_format: "float",
    },
  });

  return decodeOpenRouterEmbeddings(body.data, {
    expectedCount: input.length,
    expectedDimensions: DEDUPE_EMBEDDING_DIMENSIONS,
  });
}

async function loadQuestions(pool, options) {
  const result = await pool.query(
    `
      SELECT
        q.user_id,
        q.id AS question_id,
        q.question,
        q.concise_answer,
        qe.source_hash AS existing_source_hash
	      FROM questions q
	      LEFT JOIN question_embeddings qe
	        ON qe.question_id = q.id
	       AND qe.user_id = q.user_id
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
      const source = buildEmbeddingSource({
        question: row.question,
        conciseAnswer: row.concise_answer,
        kind: options.kind,
        sourceVersion: options.sourceVersion,
      });

      return {
        ...row,
        source,
        source_hash: hashEmbeddingSource(source),
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
          user_id,
          question_id,
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::vector, $9, $9)
        ON CONFLICT (
          user_id,
          question_id,
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
        row.user_id,
        row.question_id,
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
  const apiKey = requireOpenRouterApiKey();
  const pool = createDatabasePool(Pool);

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
      logSavedProgress(saved, questions.length);
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
