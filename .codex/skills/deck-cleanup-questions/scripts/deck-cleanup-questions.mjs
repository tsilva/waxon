import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_DECK_ID = "deep-learning";
const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
const DEFAULT_BATCH_SIZE = 32;

function parseArgs(argv) {
  const options = {
    apply: false,
    approvalTable: false,
    batchSize: DEFAULT_BATCH_SIZE,
    changesPath: null,
    deckId: DEFAULT_DECK_ID,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    json: false,
    limit: 0,
    offset: 0,
    validateChanges: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--approval-table") {
      options.approvalTable = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--validate-changes") {
      options.validateChanges = true;
      continue;
    }

    if (arg === "--batch-size") {
      options.batchSize = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--changes") {
      options.changesPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--deck-id") {
      options.deckId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--embedding-model") {
      options.embeddingModel = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--offset") {
      options.offset = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.changesPath = options.changesPath?.trim() || null;
  options.deckId = options.deckId.trim();
  options.embeddingModel = options.embeddingModel.trim();

  if (!options.deckId) {
    throw new Error("--deck-id must not be empty");
  }

  if (!options.embeddingModel) {
    throw new Error("--embedding-model must not be empty");
  }

  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 128
  ) {
    throw new Error("--batch-size must be an integer from 1 to 128");
  }

  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer");
  }

  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error("--offset must be a non-negative integer");
  }

  const changeModeCount = [
    options.apply,
    options.approvalTable,
    options.validateChanges,
  ].filter(Boolean).length;

  if (changeModeCount > 1) {
    throw new Error(
      "--apply, --approval-table, and --validate-changes are mutually exclusive",
    );
  }

  if (changeModeCount > 0 && !options.changesPath) {
    throw new Error(
      "--apply, --approval-table, and --validate-changes require --changes <path>",
    );
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

function roughTokenCount(text) {
  return text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g)?.length ?? 0;
}

function markdownContentText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+?)`{1,3}/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w])\*(?=\S)([\s\S]*?\S)\*(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?=[^\w]|$)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\$\$(?=\S)([\s\S]*?\S)\$\$/g, "$1")
    .replace(/\$(?=\S)([^$\n]*?\S)\$/g, "$1");
}

function roughContentTokenCount(text) {
  return roughTokenCount(markdownContentText(text));
}

function hasMarkdownFormatting(text) {
  return (
    /!\[[^\]]*\]\([^)]+\)/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /`{1,3}[^`]+?`{1,3}/.test(text) ||
    /(\*\*|__)(?=\S)[\s\S]*?\S\1/.test(text) ||
    /(^|[^\w])\*(?=\S)[\s\S]*?\S\*(?=[^\w]|$)/.test(text) ||
    /(^|[^\w])_(?=\S)[\s\S]*?\S_(?=[^\w]|$)/.test(text) ||
    /~~(?=\S)[\s\S]*?\S~~/.test(text) ||
    /\$\$(?=\S)[\s\S]*?\S\$\$/.test(text) ||
    /\$(?=\S)[^$\n]*?\S\$/.test(text)
  );
}

function markdownFormattingSignature(text) {
  const pattern =
    /!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`{1,3}[^`]+?`{1,3}|(\*\*|__)(?=\S)[\s\S]*?\S\1|(^|[^\w])\*(?=\S)[\s\S]*?\S\*(?=[^\w]|$)|(^|[^\w])_(?=\S)[\s\S]*?\S_(?=[^\w]|$)|~~(?=\S)[\s\S]*?\S~~|\$\$(?=\S)[\s\S]*?\S\$\$|\$(?=\S)[^$\n]*?\S\$/g;
  return [...text.matchAll(pattern)].map((match) => match[0]).join("\n");
}

function vectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function questionSlug(question) {
  const slug = question
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug) {
    return slug;
  }

  return `question-${createHash("sha256")
    .update(question)
    .digest("hex")
    .slice(0, 16)}`;
}

function normalizeEmbeddingText(value) {
  return value.trim().replace(/\s+/g, " ");
}

function buildQuestionOnlyEmbeddingSource(question) {
  return [
    "version: 1",
    "kind: question_only",
    `Question: ${normalizeEmbeddingText(question)}`,
  ].join("\n");
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
  const limitClause = options.limit > 0 ? "LIMIT $2 OFFSET $3" : "";
  const params =
    options.limit > 0
      ? [options.deckId, options.limit, options.offset]
      : [options.deckId];

  const result = await pool.query(
    `
      SELECT
        q.id,
        q.deck_id,
        q.question,
        q.question_slug,
        q.reviews,
        q.next_due,
        q.generated_from_question,
        q.last_answer,
        q.last_answer_summary,
        q.concise_answer,
        q.reference_answer,
        q.created_at,
        q.updated_at
      FROM questions q
      WHERE q.deck_id = $1
      ORDER BY q.created_at ASC, q.question ASC
      ${limitClause}
    `,
    params,
  );

  return result.rows;
}

function printQuestionReport(questions, options) {
  const rows = questions.map((row, index) => ({
    index: options.offset + index + 1,
    question: row.question,
    rawRoughTokens: roughTokenCount(row.question),
    roughTokens: roughContentTokenCount(row.question),
    chars: row.question.length,
  }));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          deckId: options.deckId,
          count: rows.length,
          limit: options.limit,
          offset: options.offset,
          questions: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Loaded ${rows.length} questions from deck ${options.deckId}.`);

  for (const row of rows) {
    console.log("");
    console.log(`${row.index}. ${row.question}`);
    console.log(
      `roughContentTokens=${row.roughTokens} rawRoughTokens=${row.rawRoughTokens} chars=${row.chars}`,
    );
  }
}

async function readChanges(path) {
  const source = await readFile(path, "utf8");
  const parsed = JSON.parse(source);
  const changes = Array.isArray(parsed) ? parsed : parsed.changes;

  if (!Array.isArray(changes)) {
    throw new Error("Changes file must be an array or { changes: [...] }");
  }

  return changes.map((change, index) => {
    const oldQuestion =
      typeof change.oldQuestion === "string" ? change.oldQuestion.trim() : "";
    const newQuestion =
      typeof change.newQuestion === "string" ? change.newQuestion.trim() : "";
    const rationale =
      typeof change.rationale === "string" && change.rationale.trim()
        ? change.rationale.trim()
        : "Equivalent question cleanup by Codex agent judgment.";

    if (!oldQuestion || !newQuestion) {
      throw new Error(`Change ${index + 1} is missing oldQuestion/newQuestion`);
    }

    return {
      newQuestion,
      oldQuestion,
      rationale,
    };
  });
}

function validateChanges(changes, activeRows) {
  const activeQuestions = new Set(activeRows.map((row) => row.question));
  const seenOld = new Set();
  const seenNew = new Set();

  for (const [index, change] of changes.entries()) {
    if (!activeQuestions.has(change.oldQuestion)) {
      throw new Error(`Change ${index + 1} oldQuestion is not active`);
    }

    if (change.oldQuestion === change.newQuestion) {
      throw new Error(`Change ${index + 1} does not change the question`);
    }

    if (activeQuestions.has(change.newQuestion)) {
      throw new Error(
        `Change ${index + 1} newQuestion already exists in the deck`,
      );
    }

    if (seenOld.has(change.oldQuestion)) {
      throw new Error(`Change ${index + 1} repeats an oldQuestion`);
    }

    if (seenNew.has(change.newQuestion)) {
      throw new Error(`Change ${index + 1} repeats a newQuestion`);
    }

    if (
      hasMarkdownFormatting(change.oldQuestion) &&
      !hasMarkdownFormatting(change.newQuestion)
    ) {
      throw new Error(
        `Change ${index + 1} removes all Markdown formatting from the question`,
      );
    }

    const oldContent = markdownContentText(change.oldQuestion);
    const newContent = markdownContentText(change.newQuestion);
    const oldTokens = roughContentTokenCount(change.oldQuestion);
    const newTokens = roughContentTokenCount(change.newQuestion);
    const tokensSaved = oldTokens - newTokens;
    const changesFormatting =
      markdownFormattingSignature(change.oldQuestion) !==
      markdownFormattingSignature(change.newQuestion);
    const isSubstantialWordingCleanup = !changesFormatting && tokensSaved > 5;
    const isFormattingCleanup = changesFormatting && newTokens <= oldTokens;

    if (!isSubstantialWordingCleanup && !isFormattingCleanup) {
      throw new Error(
        `Change ${index + 1} is not a formatting cleanup and does not save more than 5 rough content tokens (${oldTokens} -> ${newTokens})`,
      );
    }

    if (changesFormatting && newTokens === oldTokens && oldContent !== newContent) {
      throw new Error(
        `Change ${index + 1} changes formatting without preserving visible content`,
      );
    }

    seenOld.add(change.oldQuestion);
    seenNew.add(change.newQuestion);
  }
}

function changeSummary(change) {
  const oldTokens = roughContentTokenCount(change.oldQuestion);
  const newTokens = roughContentTokenCount(change.newQuestion);

  return {
    newQuestion: change.newQuestion,
    newTokens,
    oldQuestion: change.oldQuestion,
    oldTokens,
    tokensSaved: oldTokens - newTokens,
  };
}

function markdownTableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printApprovalTable(changes) {
  const summaries = changes.map(changeSummary);
  const totalTokensSaved = summaries.reduce(
    (total, summary) => total + summary.tokensSaved,
    0,
  );

  console.log(
    "| # | Old question | New question | Old tokens | New tokens | Saved |",
  );
  console.log("|---:|---|---|---:|---:|---:|");

  for (const [index, summary] of summaries.entries()) {
    console.log(
      `| ${index + 1} | ${markdownTableCell(summary.oldQuestion)} | ${markdownTableCell(summary.newQuestion)} | ${summary.oldTokens} | ${summary.newTokens} | ${summary.tokensSaved} |`,
    );
  }

  console.log("");
  console.log(
    `Total changes: ${summaries.length}; total rough content tokens saved: ${totalTokensSaved}`,
  );
}

async function saveAtomicChanges(pool, rowsByOldQuestion, changes, embeddings, model) {
  const now = Date.now();
  const questionMap = new Map(
    changes.map((change) => [change.oldQuestion, change.newQuestion]),
  );
  const replacementRows = new Map();

  await pool.query("BEGIN");

  try {
    for (const change of changes) {
      const row = rowsByOldQuestion.get(change.oldQuestion);

      if (!row) {
        throw new Error(`Question disappeared before apply: ${change.oldQuestion}`);
      }

      const insertResult = await pool.query(
        `
          INSERT INTO questions (
            question,
            question_slug,
            deck_id,
            reviews,
            next_due,
            generated_from_question,
            last_answer,
            last_answer_summary,
            concise_answer,
            reference_answer,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11)
          RETURNING id, deck_id, question
        `,
        [
          change.newQuestion,
          questionSlug(change.newQuestion),
          row.deck_id,
          row.reviews,
          row.next_due,
          row.last_answer,
          row.last_answer_summary,
          row.concise_answer,
          row.reference_answer,
          row.created_at,
          now,
        ],
      );

      replacementRows.set(change.oldQuestion, insertResult.rows[0]);
    }

    for (const change of changes) {
      const row = rowsByOldQuestion.get(change.oldQuestion);
      const replacement = replacementRows.get(change.oldQuestion);

      await pool.query(
        `
          UPDATE question_attempts
          SET
            question_id = $1,
            question = $2
          WHERE deck_id = $3
            AND question_id = $4
        `,
        [replacement.id, change.newQuestion, row.deck_id, row.id],
      );

      await pool.query(
        `
          UPDATE question_reviews
          SET
            question_id = $1,
            question = $2
          WHERE deck_id = $3
            AND question_id = $4
        `,
        [replacement.id, change.newQuestion, row.deck_id, row.id],
      );

      await pool.query(
        `
          UPDATE question_embeddings
          SET
            question_id = $1,
            question = $2,
            is_current = false,
            updated_at = $3
          WHERE deck_id = $4
            AND question_id = $5
        `,
        [replacement.id, change.newQuestion, now, row.deck_id, row.id],
      );

      await pool.query(
        `
          UPDATE questions
          SET
            generated_from_question = $1,
            updated_at = $2
          WHERE deck_id = $3
            AND generated_from_question = $4
        `,
        [change.newQuestion, now, row.deck_id, change.oldQuestion],
      );
    }

    for (const change of changes) {
      const row = rowsByOldQuestion.get(change.oldQuestion);
      const replacement = replacementRows.get(change.oldQuestion);
      const generatedFromQuestion = row.generated_from_question
        ? questionMap.get(row.generated_from_question) ?? row.generated_from_question
        : null;

      await pool.query(
        `
          UPDATE questions
          SET
            generated_from_question = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [generatedFromQuestion, now, replacement.id],
      );
    }

    for (const change of changes) {
      const row = rowsByOldQuestion.get(change.oldQuestion);
      const deleteResult = await pool.query(
        `
          DELETE FROM questions
          WHERE deck_id = $1
            AND id = $2
        `,
        [row.deck_id, row.id],
      );

      if (deleteResult.rowCount !== 1) {
        throw new Error(
          `Expected to delete 1 old question, deleted ${deleteResult.rowCount}`,
        );
      }
    }

    for (const [index, change] of changes.entries()) {
      const replacement = replacementRows.get(change.oldQuestion);
      const source = buildQuestionOnlyEmbeddingSource(change.newQuestion);

      await pool.query(
        `
          INSERT INTO question_embeddings (
            deck_id,
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
          VALUES ($1, $2, $3, $4, 'question_only', 1, $5, true, $6::vector, $7, $7)
          ON CONFLICT (
            deck_id,
            question_id,
            embedding_model,
            embedding_kind,
            source_version
          )
          DO UPDATE SET
            question = excluded.question,
            embedding = excluded.embedding,
            source_hash = excluded.source_hash,
            is_current = true,
            updated_at = excluded.updated_at
        `,
        [
          replacement.deck_id,
          replacement.id,
          change.newQuestion,
          model,
          sourceHash(source),
          vectorLiteral(embeddings[index]),
          now,
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
  const pool = new Pool({ connectionString });

  try {
    if (!options.apply && !options.approvalTable && !options.validateChanges) {
      const questions = await loadQuestions(pool, options);
      printQuestionReport(questions, options);
      return;
    }

    const changes = await readChanges(options.changesPath);

    if (changes.length === 0) {
      console.log("No question cleanups.");
      return;
    }

    const activeRows = await loadQuestions(pool, {
      ...options,
      limit: 0,
      offset: 0,
    });
    validateChanges(changes, activeRows);

    if (options.validateChanges) {
      console.log(`${changes.length} changes checked; all valid`);
      return;
    }

    if (options.approvalTable) {
      printApprovalTable(changes);
      return;
    }

    const apiKey = requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");

    const rowsByOldQuestion = new Map(
      activeRows.map((row) => [row.question, row]),
    );

    console.log(
      `Embedding ${changes.length} cleaned questions with ${options.embeddingModel}.`,
    );

    const embeddings = [];

    for (const batch of chunks(changes, options.batchSize)) {
      const batchEmbeddings = await fetchEmbeddings(
        batch.map((change) => buildQuestionOnlyEmbeddingSource(change.newQuestion)),
        options.embeddingModel,
        apiKey,
      );
      embeddings.push(...batchEmbeddings);
      console.log(`Embedded ${embeddings.length}/${changes.length}`);
    }

    await saveAtomicChanges(
      pool,
      rowsByOldQuestion,
      changes,
      embeddings,
      options.embeddingModel,
    );

    for (const change of changes) {
      console.log(`Cleaned: ${change.oldQuestion}`);
      console.log(`      -> ${change.newQuestion}`);
    }

    console.log(`Applied ${changes.length} question cleanups atomically.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
