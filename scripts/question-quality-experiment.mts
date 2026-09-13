import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { ANSWER_MODEL, flagDetail, runConcurrent, runQuestion, type ExperimentQuestion, type ExperimentResult } from "../shared/question-quality-experiment.mts";
import { DEFAULT_OPENROUTER_EVALUATION_MODEL, resolveOpenRouterApiKey } from "../shared/openrouter-config.mts";

const { values } = parseArgs({ options: {
  "user-id": { type: "string" },
  limit: { type: "string", default: "2" },
  concurrency: { type: "string", default: "4" },
  output: { type: "string", default: "test-results/question-quality/prompt-only.jsonl" },
  "apply-flags": { type: "boolean", default: false },
} });
for (const envFile of [".env", ".env.local"]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("Run with keyenv run -- to supply database access.");
if (!resolveOpenRouterApiKey()) throw new Error("OpenRouter API key is required.");
// The production evaluator's trace writer is disabled without DATABASE_URL.
// Keep database access only in these explicit SQL connections, never in evaluator code.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_UNPOOLED;
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Concurrency must be 1–16.");
const limit = values.limit === "all" ? null : Number(values.limit);
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error("Limit must be a positive integer or all.");
const output = resolve(values.output!);
mkdirSync(dirname(output), { recursive: true });
const pool = new pg.Pool({ connectionString, options: "-c default_transaction_read_only=on", max: 1 });
let questions: ExperimentQuestion[];
let userId: string;
try {
  if (values["user-id"]) userId = values["user-id"];
  else {
    const users = await pool.query<{ user_id: string }>("SELECT DISTINCT user_id FROM waxon_v2.questions LIMIT 2");
    if (users.rows.length !== 1) throw new Error("Specify --user-id to select exactly one learner's bank.");
    userId = users.rows[0].user_id;
  }
  const rows = await pool.query<ExperimentQuestion>(
    `SELECT id, user_id AS "userId", prompt, reference_answer AS "referenceAnswer", lifecycle
       FROM waxon_v2.questions WHERE user_id = $1 ORDER BY creation_order, id LIMIT $2`,
    [userId, limit],
  );
  questions = rows.rows;
} finally { await pool.end(); }

const evaluatorModel = process.env.LLM_EVALUATION_MODEL?.trim() || DEFAULT_OPENROUTER_EVALUATION_MODEL;
const codeHash = createHash("sha256");
for (const path of ["app/lib/v2/model.ts", "app/lib/v2/recallEvaluation.ts", "shared/question-quality-experiment.mts", "scripts/question-quality-experiment.mts"]) codeHash.update(readFileSync(path));
const signature = createHash("sha256").update(JSON.stringify({ userId, evaluatorModel, answerModel: ANSWER_MODEL, code: codeHash.digest("hex") })).digest("hex");
const manifestPath = `${output}.manifest.json`;
let manifest = { runId: randomUUID() as string, signature, userId, answerModel: ANSWER_MODEL, answerReasoning: false, evaluatorModel, startedAt: new Date().toISOString() };
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.signature !== signature) throw new Error("Existing run uses different code, learner, or models. Choose a new --output.");
} else {
  if (existsSync(output)) throw new Error("Output exists without a manifest. Choose a new --output.");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
}
const results = new Map<string, ExperimentResult>();
if (existsSync(output)) {
  for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
    const result = JSON.parse(line) as ExperimentResult;
    results.set(result.question.id, result);
  }
}
const pending = questions.filter((question) => {
  const previous = results.get(question.id);
  return !previous?.evaluation || previous.error || previous.question.prompt !== question.prompt || previous.question.referenceAnswer !== question.referenceAnswer;
});
console.log(JSON.stringify({ selected: questions.length, pending: pending.length, concurrency, evaluatorModel, answerModel: ANSWER_MODEL, applyFlags: values["apply-flags"], output }));
let consecutiveFailures = 0;
await runConcurrent(pending, concurrency, async (question) => {
  const previous = results.get(question.id);
  const reusableAnswer = previous?.question.prompt === question.prompt && previous.question.referenceAnswer === question.referenceAnswer ? previous.answer : undefined;
  const result = await runQuestion(question, reusableAnswer ? async () => reusableAnswer : undefined);
  result.answerRouting = reusableAnswer ? previous?.answerRouting ?? "default" : "throughput";
  // Synchronous append keeps concurrent workers' checkpoint records intact.
  appendFileSync(output, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  results.set(question.id, result);
  console.log(JSON.stringify({ questionId: question.id, result: result.evaluation?.recallResult ?? "error", error: result.error }));
  consecutiveFailures = result.error ? consecutiveFailures + 1 : 0;
  if (consecutiveFailures >= 5) {
    console.error("Stopping new requests after five consecutive failed questions. Resume after the provider recovers.");
    return false;
  }
});

let flagged = 0;
let skippedFlags = 0;
if (values["apply-flags"]) {
  const writer = new pg.Client({ connectionString });
  await writer.connect();
  try {
    for (const question of questions) {
      const result = results.get(question.id);
      if (!result) continue;
      const detail = flagDetail(result, manifest.runId);
      if (!detail) continue;
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`question-bank:${userId}`]);
        await writer.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`review-queue:${userId}`]);
        const current = await writer.query<{ lifecycle: string }>(
          "SELECT lifecycle FROM waxon_v2.questions WHERE user_id=$1 AND id=$2 AND prompt=$3 AND reference_answer=$4 FOR UPDATE",
          [userId, question.id, question.prompt, question.referenceAnswer],
        );
        const duplicate = await writer.query(
          "SELECT 1 FROM waxon_v2.question_flags WHERE user_id=$1 AND question_id=$2 AND detail LIKE $3",
          [userId, question.id, `[Question quality experiment ${manifest.runId}]%`],
        );
        if (!current.rows.length || current.rows[0].lifecycle === "archived" || duplicate.rows.length) {
          skippedFlags++;
        } else {
          await writer.query("UPDATE waxon_v2.questions SET lifecycle='flagged',updated_at=now() WHERE user_id=$1 AND id=$2", [userId, question.id]);
          await writer.query("INSERT INTO waxon_v2.question_flags (user_id,question_id,origin,reasons,detail) VALUES ($1,$2,'learner','[]'::jsonb,$3)", [userId, question.id, detail]);
          flagged++;
        }
        await writer.query("COMMIT");
      } catch (error) { await writer.query("ROLLBACK"); throw error; }
    }
  } finally { await writer.end(); }
}
const counts = { correct: 0, partial: 0, incorrect: 0, error: 0, unprocessed: 0 };
for (const question of questions) {
  const result = results.get(question.id);
  counts[result?.evaluation?.recallResult ?? (result ? "error" : "unprocessed")]++;
}
const summary = { ...manifest, selected: questions.length, counts, flagsWritten: flagged, skippedFlags, output, finishedAt: new Date().toISOString() };
writeFileSync(`${output}.summary.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
if (counts.error || counts.unprocessed) process.exitCode = 1;
