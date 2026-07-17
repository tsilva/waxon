import { Pool, neonConfig } from "@neondatabase/serverless";
import {
  buildConciseAnswerRequest,
  parseConciseAnswerResults,
} from "../shared/concise-answer-contract.mjs";
import {
  chunks,
  configureNeonWebSocket,
  createDatabasePool,
  extractOpenRouterChatText,
  fetchOpenRouterJson,
  loadLocalEnvFiles,
  logSavedProgress,
  OPENROUTER_CHAT_URL,
  openRouterChatModel,
  requireOpenRouterApiKey,
} from "./lib/runtime.mjs";

loadLocalEnvFiles();
configureNeonWebSocket(neonConfig);

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
  const body = await fetchOpenRouterJson(OPENROUTER_CHAT_URL, {
    apiKey,
    errorPrefix: "Concise answer request failed",
    errorTextLength: 300,
    body: buildConciseAnswerRequest({
      model: openRouterChatModel(),
      questions: batch,
    }),
  });

  return parseConciseAnswerResults(batch, extractOpenRouterChatText(body));
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
      const rows = (await generateConciseAnswers(batch, apiKey)).filter(
        (row) => row.conciseAnswer,
      );

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
