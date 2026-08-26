import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";
import {
  QUESTION_SEARCH_SOURCE_VERSION,
  questionSearchVectorLiteral,
  requestQuestionSearchEmbeddings,
  resolveQuestionSearchConfig,
} from "../shared/question-search.mts";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and keyenv can provide configuration without local env files.
  }
}

function flag(name: string): string | null {
  const value = process.argv.find((item) => item.startsWith(`${name}=`));
  return value?.slice(name.length + 1) ?? null;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

const userId = flag("--user-id")?.trim();
if (!userId) {
  throw new Error(
    "A learner is required: pnpm question-search:benchmark -- --user-id=<id>",
  );
}
const parsedIterations = Number(flag("--iterations") ?? 50);
const iterations = Math.max(5, Math.min(500, Math.trunc(parsedIterations) || 50));
const includeHybrid = process.argv.includes("--include-hybrid");
const explain = process.argv.includes("--explain");
const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const lexicalTimes: number[] = [];
const exactTimes: number[] = [];
const hybridTimes: number[] = [];
let hybridPromptTokens = 0;
let hybridCostUsd = 0;

const lexicalSql = `
  WITH query AS (
    SELECT websearch_to_tsquery('simple', $2) AS tsquery
  ), fts AS (
    SELECT q.id,
           row_number() OVER (ORDER BY ts_rank_cd(
             setweight(to_tsvector('simple', coalesce(q.prompt, '')), 'A') ||
             setweight(to_tsvector('simple', coalesce(q.reference_answer, '')), 'B'),
             query.tsquery, 32
           ) DESC, q.id) AS rank
      FROM waxon_v2.questions q
      CROSS JOIN query
     WHERE q.user_id = $1
       AND (
         setweight(to_tsvector('simple', coalesce(q.prompt, '')), 'A') ||
         setweight(to_tsvector('simple', coalesce(q.reference_answer, '')), 'B')
       ) @@ query.tsquery
     ORDER BY rank
     LIMIT 25
  ), trigram AS (
    SELECT q.id, row_number() OVER (ORDER BY q.prompt <-> $2, q.id) AS rank
      FROM waxon_v2.questions q
     WHERE q.user_id = $1 AND similarity(q.prompt, $2) >= 0.3
     ORDER BY rank
     LIMIT 25
  ), scores AS (
    SELECT id, sum(1.0 / (60 + rank)) AS score
      FROM (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM trigram
      ) branches
     GROUP BY id
  )
  SELECT id FROM scores ORDER BY score DESC, id LIMIT 10`;

try {
  const [countResult, sampleResult] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM waxon_v2.questions WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ prompt: string }>(
      `SELECT q.prompt
         FROM waxon_v2.questions q
        WHERE q.user_id = $1
        ORDER BY q.updated_at DESC
        LIMIT 20`,
      [userId],
    ),
  ]);
  const prompts = sampleResult.rows.map((row) => row.prompt);
  if (prompts.length === 0) throw new Error("The selected learner has no questions.");
  for (let index = 0; index < iterations; index += 1) {
    const prompt = prompts[index % prompts.length] as string;
    let startedAt = performance.now();
    await pool.query(
      `SELECT id FROM waxon_v2.questions
        WHERE user_id = $1 AND target_key = $2 LIMIT 10`,
      [userId, questionPromptKey(prompt)],
    );
    exactTimes.push(performance.now() - startedAt);
    startedAt = performance.now();
    await pool.query(lexicalSql, [userId, prompt.slice(0, 2_000)]);
    lexicalTimes.push(performance.now() - startedAt);
    if (includeHybrid) {
      startedAt = performance.now();
      const embedded = await requestQuestionSearchEmbeddings({
        prompts: [prompt],
        userId,
      });
      const vector = questionSearchVectorLiteral(embedded.embeddings[0] ?? []);
      await pool.query(
        `SELECT question_id
           FROM waxon_v2.question_search_embeddings
          WHERE user_id = $1 AND model = $2 AND source_version = $3
          ORDER BY embedding <#> $4::halfvec(512), question_id
          LIMIT 25`,
        [
          userId,
          embedded.model,
          QUESTION_SEARCH_SOURCE_VERSION,
          vector,
        ],
      );
      hybridTimes.push(performance.now() - startedAt);
      const tokens = Number(embedded.usage?.prompt_tokens);
      if (Number.isFinite(tokens)) hybridPromptTokens += tokens;
      const cost = Number(embedded.usage?.cost);
      if (Number.isFinite(cost)) hybridCostUsd += cost;
    }
  }
  if (explain) {
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lexicalSql}`,
      [userId, prompts[0]?.slice(0, 2_000)],
    );
    console.log(JSON.stringify({ lexicalPlan: plan.rows[0] }, null, 2));
  }
  const bankQuestions = Number(countResult.rows[0]?.count ?? 0);
  const output = {
    userId,
    bankQuestions,
    expectedScaleTier:
      bankQuestions >= 100_000 ? "100k" : bankQuestions >= 10_000 ? "10k" : "1k",
    iterations,
    exact: {
      p50Ms: percentile(exactTimes, 0.5),
      p95Ms: percentile(exactTimes, 0.95),
      p99Ms: percentile(exactTimes, 0.99),
    },
    lexical: {
      p50Ms: percentile(lexicalTimes, 0.5),
      p95Ms: percentile(lexicalTimes, 0.95),
      p99Ms: percentile(lexicalTimes, 0.99),
      p95GateMs: 50,
      passes: percentile(lexicalTimes, 0.95) < 50,
    },
    hybrid: includeHybrid
      ? {
          p50Ms: percentile(hybridTimes, 0.5),
          p95Ms: percentile(hybridTimes, 0.95),
          p99Ms: percentile(hybridTimes, 0.99),
          p95GateMs: 750,
          passes: percentile(hybridTimes, 0.95) < 750,
          promptTokens: hybridPromptTokens,
          providerCostUsd: hybridCostUsd,
          model: resolveQuestionSearchConfig().model,
        }
      : null,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.lexical.passes || (output.hybrid && !output.hybrid.passes)) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
