import { readFile } from "node:fs/promises";
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

const DEFAULT_DECK_ID = "deep-learning";
const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_MAX_PAIRS = 80;
const AGENT_JUDGE_LABEL = "codex-agent-native";

function parseArgs(argv) {
  const options = {
    apply: false,
    deckId: DEFAULT_DECK_ID,
    decisionsPath: null,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    json: false,
    maxPairs: DEFAULT_MAX_PAIRS,
    threshold: DEFAULT_THRESHOLD,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--deck-id") {
      options.deckId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--decisions") {
      options.decisionsPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--embedding-model") {
      options.embeddingModel = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--threshold") {
      options.threshold = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--max-pairs") {
      options.maxPairs = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.deckId = options.deckId.trim();
  options.embeddingModel = options.embeddingModel.trim();
  options.decisionsPath = options.decisionsPath?.trim() || null;

  if (!options.deckId) {
    throw new Error("--deck-id must not be empty");
  }

  if (!options.embeddingModel) {
    throw new Error("--embedding-model must not be empty");
  }

  if (
    !Number.isFinite(options.threshold) ||
    options.threshold <= 0 ||
    options.threshold > 1
  ) {
    throw new Error("--threshold must be a number greater than 0 and <= 1");
  }

  if (!Number.isInteger(options.maxPairs) || options.maxPairs < 1) {
    throw new Error("--max-pairs must be a positive integer");
  }

  if (options.apply && !options.decisionsPath) {
    throw new Error("--apply requires --decisions <path>");
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

function parseVectorLiteral(value) {
  return value
    .slice(1, -1)
    .split(",")
    .filter(Boolean)
    .map((component) => Number(component));
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

async function loadQuestions(pool, options) {
  const result = await pool.query(
    `
      SELECT
        q.deck_id,
        q.question,
        q.reviews,
        q.next_due,
        q.generated_from_question,
        q.last_answer,
        q.last_answer_summary,
        q.reference_answer,
        q.created_at,
        q.updated_at,
        qe.embedding::text AS embedding
      FROM questions q
      JOIN question_embeddings qe ON qe.question = q.question
      WHERE q.deck_id = $1
        AND qe.embedding_model = $2
      ORDER BY q.created_at ASC, q.question ASC
    `,
    [options.deckId, options.embeddingModel],
  );

  return result.rows.map((row) => ({
    ...row,
    embedding: parseVectorLiteral(row.embedding),
  }));
}

function buildCandidatePairs(questions, threshold, maxPairs) {
  const pairs = [];

  for (let left = 0; left < questions.length; left += 1) {
    for (let right = left + 1; right < questions.length; right += 1) {
      const similarity = cosineSimilarity(
        questions[left].embedding,
        questions[right].embedding,
      );

      if (similarity >= threshold) {
        pairs.push({
          pairId: `pair-${pairs.length + 1}`,
          questionA: questions[left].question,
          questionB: questions[right].question,
          similarity,
        });
      }
    }
  }

  return pairs
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxPairs)
    .map((pair, index) => ({
      ...pair,
      pairId: `pair-${index + 1}`,
      similarity: Number(pair.similarity.toFixed(6)),
    }));
}

function printCandidateReport(questions, pairs, options) {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          deckId: options.deckId,
          embeddingModel: options.embeddingModel,
          questionCount: questions.length,
          threshold: options.threshold,
          candidates: pairs,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `Loaded ${questions.length} embedded questions from deck ${options.deckId}.`,
  );
  console.log(
    `Found ${pairs.length} candidate pairs at threshold ${options.threshold}.`,
  );

  for (const pair of pairs) {
    console.log("");
    console.log(`${pair.pairId} similarity ${pair.similarity.toFixed(4)}`);
    console.log(`A: ${pair.questionA}`);
    console.log(`B: ${pair.questionB}`);
  }

  if (pairs.length > 0) {
    console.log("");
    console.log(
      "Codex should review these pairs and write a decisions JSON before applying.",
    );
  }
}

async function readDecisions(path) {
  const source = await readFile(path, "utf8");
  const parsed = JSON.parse(source);
  const decisions = Array.isArray(parsed) ? parsed : parsed.decisions;

  if (!Array.isArray(decisions)) {
    throw new Error("Decisions file must be an array or { decisions: [...] }");
  }

  return decisions
    .filter((decision) => decision?.duplicate === true)
    .map((decision, index) => {
      const keepQuestion =
        typeof decision.keepQuestion === "string"
          ? decision.keepQuestion.trim()
          : "";
      const discardQuestion =
        typeof decision.discardQuestion === "string"
          ? decision.discardQuestion.trim()
          : "";
      const rationale =
        typeof decision.rationale === "string" && decision.rationale.trim()
          ? decision.rationale.trim()
          : "Duplicate by Codex agent judgment.";

      if (!keepQuestion || !discardQuestion) {
        throw new Error(`Decision ${index + 1} is missing keep/discard question`);
      }

      if (keepQuestion === discardQuestion) {
        throw new Error(`Decision ${index + 1} keeps and discards the same question`);
      }

      return {
        discardQuestion,
        keepQuestion,
        rationale,
        similarity:
          typeof decision.similarity === "number" &&
          Number.isFinite(decision.similarity)
            ? decision.similarity
            : 0,
      };
    });
}

async function ensureTrashTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions_trash (
      question text PRIMARY KEY,
      deck_id text NOT NULL,
      reviews text NOT NULL DEFAULT '',
      next_due bigint NOT NULL DEFAULT 0,
      generated_from_question text,
      last_answer text NOT NULL DEFAULT '',
      last_answer_summary text NOT NULL DEFAULT '',
      reference_answer text NOT NULL DEFAULT '',
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      trashed_at bigint NOT NULL,
      duplicate_of_question text NOT NULL,
      duplicate_similarity double precision NOT NULL,
      duplicate_embedding_model text NOT NULL,
      duplicate_judge_model text NOT NULL,
      duplicate_rationale text NOT NULL
    )
  `);
}

function validateDecision(decision, questionByText, discarded) {
  if (!questionByText.has(decision.keepQuestion)) {
    throw new Error(`Keep question is not active: ${decision.keepQuestion}`);
  }

  if (!questionByText.has(decision.discardQuestion)) {
    throw new Error(`Discard question is not active: ${decision.discardQuestion}`);
  }

  if (discarded.has(decision.keepQuestion)) {
    throw new Error(`Keep question was already discarded: ${decision.keepQuestion}`);
  }

  if (discarded.has(decision.discardQuestion)) {
    return false;
  }

  return true;
}

async function moveToTrash(pool, decision, questionByText, options) {
  const discard = questionByText.get(decision.discardQuestion);
  const trashedAt = Date.now();

  if (!discard) {
    throw new Error(`Discard question is no longer active: ${decision.discardQuestion}`);
  }

  await pool.query("BEGIN");

  try {
    await pool.query(
      `
        INSERT INTO questions_trash (
          question,
          deck_id,
          reviews,
          next_due,
          generated_from_question,
          last_answer,
          last_answer_summary,
          reference_answer,
          created_at,
          updated_at,
          trashed_at,
          duplicate_of_question,
          duplicate_similarity,
          duplicate_embedding_model,
          duplicate_judge_model,
          duplicate_rationale
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT (question)
        DO UPDATE SET
          trashed_at = excluded.trashed_at,
          duplicate_of_question = excluded.duplicate_of_question,
          duplicate_similarity = excluded.duplicate_similarity,
          duplicate_embedding_model = excluded.duplicate_embedding_model,
          duplicate_judge_model = excluded.duplicate_judge_model,
          duplicate_rationale = excluded.duplicate_rationale
      `,
      [
        discard.question,
        discard.deck_id,
        discard.reviews,
        discard.next_due,
        discard.generated_from_question,
        discard.last_answer,
        discard.last_answer_summary,
        discard.reference_answer,
        discard.created_at,
        discard.updated_at,
        trashedAt,
        decision.keepQuestion,
        decision.similarity,
        options.embeddingModel,
        AGENT_JUDGE_LABEL,
        decision.rationale,
      ],
    );

    const deleteResult = await pool.query(
      `
        DELETE FROM questions
        WHERE deck_id = $1
          AND question = $2
      `,
      [options.deckId, decision.discardQuestion],
    );

    if (deleteResult.rowCount !== 1) {
      throw new Error(`Expected to delete 1 question, deleted ${deleteResult.rowCount}`);
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
    const questions = await loadQuestions(pool, options);
    const questionByText = new Map(
      questions.map((question) => [question.question, question]),
    );

    if (!options.apply) {
      const pairs = buildCandidatePairs(
        questions,
        options.threshold,
        options.maxPairs,
      );
      printCandidateReport(questions, pairs, options);
      return;
    }

    const decisions = await readDecisions(options.decisionsPath);

    if (decisions.length === 0) {
      console.log("No duplicate decisions to apply.");
      return;
    }

    await ensureTrashTable(pool);

    const discarded = new Set();
    let moved = 0;

    for (const decision of decisions) {
      if (!validateDecision(decision, questionByText, discarded)) {
        continue;
      }

      await moveToTrash(pool, decision, questionByText, options);
      discarded.add(decision.discardQuestion);
      moved += 1;
      console.log(`Moved to trash: ${decision.discardQuestion}`);
    }

    console.log(`Moved ${moved} duplicate questions to questions_trash.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
