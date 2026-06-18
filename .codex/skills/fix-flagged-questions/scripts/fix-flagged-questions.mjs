import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Pool, neonConfig } from "@neondatabase/serverless";

for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";

function parseArgs(argv) {
  const options = {
    apply: false,
    changesPath: "",
    confirmOpenRouterExport: false,
    deckId: "",
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    list: false,
    verify: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--list") {
      options.list = true;
      continue;
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--verify") {
      options.verify = true;
      continue;
    }

    if (arg === "--confirm-openrouter-export") {
      options.confirmOpenRouterExport = true;
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  const modes = [options.list, options.apply, options.verify].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error("Choose exactly one mode: --list, --apply, or --verify");
  }

  if ((options.apply || options.verify) && !options.changesPath.trim()) {
    throw new Error("--apply and --verify require --changes <path>");
  }

  if (options.apply && !options.confirmOpenRouterExport) {
    throw new Error(
      "--apply requires --confirm-openrouter-export after explicit user approval",
    );
  }

  if (!options.embeddingModel.trim()) {
    throw new Error("--embedding-model must not be empty");
  }

  return {
    ...options,
    changesPath: options.changesPath.trim(),
    deckId: options.deckId.trim(),
    embeddingModel: options.embeddingModel.trim(),
  };
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

function questionSlug(question) {
  const slug = question
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    slug ||
    `question-${createHash("sha256").update(question).digest("hex").slice(0, 16)}`
  );
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

function vectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

function toIso(value) {
  return value === null || value === undefined
    ? null
    : new Date(Number(value)).toISOString();
}

async function readChanges(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const changes = Array.isArray(parsed) ? parsed : parsed.changes;

  if (!Array.isArray(changes)) {
    throw new Error("Changes file must be an array or { changes: [...] }");
  }

  return changes.map((change, index) => {
    const oldQuestion =
      typeof change.oldQuestion === "string" ? change.oldQuestion.trim() : "";
    const newQuestion =
      typeof change.newQuestion === "string" ? change.newQuestion.trim() : "";

    if (!oldQuestion || !newQuestion) {
      throw new Error(`Change ${index + 1} is missing oldQuestion/newQuestion`);
    }

    if (oldQuestion === newQuestion) {
      throw new Error(`Change ${index + 1} does not change the question`);
    }

    return {
      oldQuestion,
      newQuestion,
      rationale:
        typeof change.rationale === "string" ? change.rationale.trim() : "",
    };
  });
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

async function listFlagged(pool, options) {
  const deckClause = options.deckId ? "AND q.deck_id = $1" : "";
  const params = options.deckId ? [options.deckId] : [];
  const result = await pool.query(
    `
      SELECT
        q.id::text,
        q.deck_id,
        d.name AS deck_name,
        q.question,
        q.concise_answer,
        q.generated_from_question,
        q.question_provenance,
        q.created_at,
        q.updated_at,
        q.flagged_at,
        coalesce(
          array_agg(ct.slug ORDER BY ct.slug) FILTER (WHERE ct.slug IS NOT NULL),
          '{}'
        ) AS concept_slugs
      FROM questions q
      JOIN decks d ON d.id = q.deck_id
      LEFT JOIN question_concept_tags qct ON qct.question_id = q.id
      LEFT JOIN concept_tags ct ON ct.id = qct.concept_tag_id
      WHERE d.archived_at IS NULL
        AND q.flagged_at IS NOT NULL
        ${deckClause}
      GROUP BY q.id, d.name
      ORDER BY q.flagged_at DESC, d.name, q.question
    `,
    params,
  );

  return result.rows.map((row) => ({
    ...row,
    created_at_iso: toIso(row.created_at),
    updated_at_iso: toIso(row.updated_at),
    flagged_at_iso: toIso(row.flagged_at),
  }));
}

async function loadRowsForChanges(pool, deckId, changes) {
  const oldQuestions = changes.map((change) => change.oldQuestion);
  const result = await pool.query(
    `
      SELECT
        id,
        deck_id,
        question,
        question_slug,
        reviews,
        next_due,
        generated_from_question,
        question_provenance,
        last_answer,
        last_answer_summary,
        concise_answer,
        reference_answer,
        flagged_at,
        created_at
      FROM questions
      WHERE deck_id = $1
        AND question = ANY($2::text[])
    `,
    [deckId, oldQuestions],
  );

  if (result.rows.length !== changes.length) {
    const found = new Set(result.rows.map((row) => row.question));
    const missing = oldQuestions.filter((question) => !found.has(question));
    throw new Error(`Missing active old questions: ${missing.join(" | ")}`);
  }

  return new Map(result.rows.map((row) => [row.question, row]));
}

async function assertNoNewQuestionDuplicates(pool, deckId, changes) {
  const result = await pool.query(
    `
      SELECT question
      FROM questions
      WHERE deck_id = $1
        AND question = ANY($2::text[])
      ORDER BY question
    `,
    [deckId, changes.map((change) => change.newQuestion)],
  );

  if (result.rows.length > 0) {
    throw new Error(
      `New questions already exist: ${result.rows
        .map((row) => row.question)
        .join(" | ")}`,
    );
  }
}

async function applyChanges(pool, options, changes) {
  if (!options.deckId) {
    throw new Error("--apply requires --deck-id");
  }

  const apiKey = requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY");
  const rowsByOldQuestion = await loadRowsForChanges(pool, options.deckId, changes);
  await assertNoNewQuestionDuplicates(pool, options.deckId, changes);

  for (const change of changes) {
    const row = rowsByOldQuestion.get(change.oldQuestion);
    if (row.flagged_at === null) {
      throw new Error(`Question is not flagged: ${change.oldQuestion}`);
    }
  }

  const embeddings = await fetchEmbeddings(
    changes.map((change) => buildQuestionOnlyEmbeddingSource(change.newQuestion)),
    options.embeddingModel,
    apiKey,
  );
  const now = Date.now();
  const questionMap = new Map(
    changes.map((change) => [change.oldQuestion, change.newQuestion]),
  );
  const replacementRows = new Map();

  await pool.query("BEGIN");

  try {
    for (const change of changes) {
      const row = rowsByOldQuestion.get(change.oldQuestion);
      const insertResult = await pool.query(
        `
          INSERT INTO questions (
            question,
            question_slug,
            deck_id,
            reviews,
            next_due,
            generated_from_question,
            question_provenance,
            last_answer,
            last_answer_summary,
            concise_answer,
            reference_answer,
            flagged_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NULL, $11, $12)
          RETURNING id, deck_id, question
        `,
        [
          change.newQuestion,
          questionSlug(change.newQuestion),
          row.deck_id,
          row.reviews,
          row.next_due,
          row.question_provenance,
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
          SET question_id = $1, question = $2
          WHERE deck_id = $3
            AND question_id = $4
        `,
        [replacement.id, change.newQuestion, row.deck_id, row.id],
      );

      await pool.query(
        `
          UPDATE question_embeddings
          SET question_id = $1,
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
          UPDATE question_concept_tags
          SET question_id = $1
          WHERE question_id = $2
        `,
        [replacement.id, row.id],
      );

      await pool.query(
        `
          UPDATE course_pages
          SET question_id = $1,
              updated_at = $2
          WHERE question_id = $3
        `,
        [replacement.id, now, row.id],
      );

      await pool.query(
        `
          UPDATE questions
          SET generated_from_question = $1,
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
          SET generated_from_question = $1,
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
          options.embeddingModel,
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

  return { applied: changes.length };
}

async function verifyChanges(pool, options, changes) {
  if (!options.deckId) {
    throw new Error("--verify requires --deck-id");
  }

  const oldQuestions = changes.map((change) => change.oldQuestion);
  const newQuestions = changes.map((change) => change.newQuestion);

  const oldRows = await pool.query(
    `
      SELECT count(*)::int AS count
      FROM questions
      WHERE deck_id = $1
        AND question = ANY($2::text[])
    `,
    [options.deckId, oldQuestions],
  );
  const newRows = await pool.query(
    `
      SELECT
        q.question,
        q.flagged_at,
        (count(qe.id) FILTER (
          WHERE qe.is_current = true
            AND qe.embedding_model = $3
            AND qe.embedding_kind = 'question_only'
        ))::int AS current_embeddings
      FROM questions q
      LEFT JOIN question_embeddings qe
        ON qe.deck_id = q.deck_id
       AND qe.question_id = q.id
      WHERE q.deck_id = $1
        AND q.question = ANY($2::text[])
      GROUP BY q.id, q.question, q.flagged_at
      ORDER BY q.question
    `,
    [options.deckId, newQuestions, options.embeddingModel],
  );

  return {
    oldQuestionRowsRemaining: oldRows.rows[0].count,
    newQuestionRows: newRows.rows.length,
    newRows: newRows.rows,
    stillFlagged: newRows.rows.filter((row) => row.flagged_at !== null),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL");
  const pool = new Pool({ connectionString });

  try {
    if (options.list) {
      console.log(JSON.stringify(await listFlagged(pool, options), null, 2));
      return;
    }

    const changes = await readChanges(options.changesPath);

    if (options.apply) {
      console.log(JSON.stringify(await applyChanges(pool, options, changes), null, 2));
      return;
    }

    console.log(JSON.stringify(await verifyChanges(pool, options, changes), null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
