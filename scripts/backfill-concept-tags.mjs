import { Pool, neonConfig } from "@neondatabase/serverless";
import { extractJsonObject } from "./lib/json-object.mjs";
import {
  chunks,
  configureNeonWebSocket,
  createDatabasePool,
  loadLocalEnvFiles,
  openRouterChatModel,
  requireOpenRouterApiKey,
  vectorLiteral,
} from "./lib/runtime.mjs";

loadLocalEnvFiles();
configureNeonWebSocket(neonConfig);

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-2";
const DEFAULT_BATCH_SIZE = 10;
const FALLBACK_CONCEPT_SLUG = "needs-concept-tagging";

function parseArgs(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    force: false,
    keepLegacyActive: false,
    limit: null,
    userId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--batch-size") {
      options.batchSize = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--keep-legacy-active") {
      options.keepLegacyActive = true;
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--user-id") {
      options.userId = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 25
  ) {
    throw new Error("--batch-size must be an integer from 1 to 25");
  }

  if (
    options.limit !== null &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("--limit must be a positive integer");
  }

  return options;
}

function normalizeConceptSlug(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function isUsefulConceptSlug(slug) {
  const normalized = normalizeConceptSlug(slug);

  if (normalized !== slug || normalized.length < 3) {
    return false;
  }

  const parts = slug.split("-").filter(Boolean);

  if (parts.length < 2) {
    return false;
  }

  if (parts.every((part) => part.length <= 3)) {
    return false;
  }

  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug);
}

function isScaffoldingConceptSlug(slug) {
  return (
    slug === "general-knowledge" ||
    slug === FALLBACK_CONCEPT_SLUG ||
    slug.startsWith("course-")
  );
}

function titleCaseSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function uniqueUsefulSlugs(value) {
  const seen = new Set();
  const slugs = [];

  if (!Array.isArray(value)) {
    return slugs;
  }

  for (const item of value) {
    const slug = normalizeConceptSlug(item);

    if (!isUsefulConceptSlug(slug) || isScaffoldingConceptSlug(slug) || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    slugs.push(slug);

    if (slugs.length >= 3) {
      break;
    }
  }

  return slugs;
}

function isLegacySlugForQuestion(row, slug) {
  return isScaffoldingConceptSlug(slug);
}

function hasRealConcept(row) {
  return row.conceptSlugs.some((slug) => !isLegacySlugForQuestion(row, slug));
}

async function assertConceptSchemaExists(pool) {
  const result = await pool.query(
    `
      SELECT
        to_regclass('public.concept_tags') AS concept_tags,
        to_regclass('public.question_concept_tags') AS question_concept_tags
    `,
  );
  const row = result.rows[0] ?? {};

  if (!row.concept_tags || !row.question_concept_tags) {
    throw new Error(
      "Concept tag tables do not exist. Run `pnpm db:migrate` before this backfill.",
    );
  }
}

async function loadLegacySlugsByUser() {
  return new Map();
}

async function loadCandidateSlugsByUser(pool, legacySlugsByUser, userId) {
  const result = await pool.query(
    `
      SELECT user_id, slug
      FROM concept_tags
      WHERE ($1::text = '' OR user_id = $1::text)
      ORDER BY user_id, slug
    `,
    [userId],
  );
  const slugsByUser = new Map();

  for (const row of result.rows) {
    const user = String(row.user_id);
    const slug = String(row.slug);
    const legacySlugs = legacySlugsByUser.get(user) ?? new Set();

    if (
      !isUsefulConceptSlug(slug) ||
      isScaffoldingConceptSlug(slug) ||
      legacySlugs.has(slug)
    ) {
      continue;
    }

    const slugs = slugsByUser.get(user) ?? [];

    slugs.push(slug);
    slugsByUser.set(user, slugs);
  }

  return slugsByUser;
}

async function loadQuestions(pool, userId) {
  const result = await pool.query(
    `
      SELECT
        q.id::text AS question_id,
        q.question,
        q.concise_answer,
        q.question_provenance,
        q.user_id,
        coalesce(array_remove(array_agg(ct.slug ORDER BY ct.slug), NULL), '{}') AS concept_slugs
      FROM questions q
      LEFT JOIN question_concept_tags qct ON qct.question_id = q.id
      LEFT JOIN concept_tags ct ON ct.id = qct.concept_tag_id
      WHERE q.flagged_at IS NULL
        AND ($1::text = '' OR q.user_id = $1::text)
      GROUP BY
        q.id,
        q.question,
        q.concise_answer,
        q.question_provenance,
        q.user_id
      ORDER BY q.user_id ASC, q.created_at ASC, q.id ASC
    `,
    [userId],
  );

  return result.rows.map((row) => ({
    questionId: String(row.question_id),
    question: String(row.question ?? ""),
    conciseAnswer: String(row.concise_answer ?? ""),
    questionProvenance: String(row.question_provenance ?? ""),
    userId: String(row.user_id),
    conceptSlugs: Array.isArray(row.concept_slugs)
      ? row.concept_slugs.map(String).filter(Boolean)
      : [],
  }));
}

function buildPrompt(batch, candidateSlugsByUser) {
  return [
    "Generate concept slugs for existing Waxon review questions.",
    "Use 1-3 lowercase kebab-case slugs for each question.",
    "Each slug must be a full, self-disambiguating concept phrase.",
    "Prefer candidateExistingSlugs when one accurately describes the tested concept.",
    "Create a new slug only when no candidate fits.",
    "Never return course titles, lesson titles, source labels, or broad container labels.",
    "Do not use acronym-only slugs such as ppo, rl, cnn, or kl unless globally unambiguous.",
    "Return strict JSON only: {\"assignments\":[{\"questionId\":\"...\",\"conceptSlugs\":[\"...\"]}]}",
    JSON.stringify({
      questions: batch.map((row) => ({
        questionId: row.questionId,
        question: row.question,
        conciseAnswer: row.conciseAnswer,
        provenance: row.questionProvenance,
        currentSlugs: row.conceptSlugs,
        candidateExistingSlugs: (candidateSlugsByUser.get(row.userId) ?? []).slice(
          0,
          80,
        ),
      })),
    }),
  ].join("\n\n");
}

function extractChatMessageText(body) {
  const content = body?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object") {
          const record = part;

          if (typeof record.text === "string") {
            return record.text;
          }

          if (typeof record.content === "string") {
            return record.content;
          }
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function generateConceptSlugs(batch, candidateSlugsByUser, apiKey) {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "waxon",
    },
    body: JSON.stringify({
      model: openRouterChatModel(),
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: Math.min(4096, 1_000 + batch.length * 350),
      messages: [
        {
          role: "system",
          content:
            "You assign compact concept slugs for a spaced-repetition question bank. Output only one valid JSON object.",
        },
        {
          role: "user",
          content: buildPrompt(batch, candidateSlugsByUser),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Concept backfill request failed: ${response.status} ${errorText.slice(0, 400)}`,
    );
  }

  const body = await response.json();
  const content = extractChatMessageText(body);
  let parsed;

  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    const snippet = content.trim().slice(0, 500);

    throw new Error(
      `${error instanceof Error ? error.message : "Could not parse model JSON."}${
        snippet ? ` Response starts: ${snippet}` : " Empty model content."
      }`,
    );
  }

  if (!Array.isArray(parsed.assignments)) {
    throw new Error("Model returned no assignments array.");
  }

  const slugsByQuestionId = new Map();

  for (const item of parsed.assignments) {
    const questionId = String(item?.questionId ?? "").trim();
    const slugs = uniqueUsefulSlugs(item?.conceptSlugs);

    if (questionId && slugs.length > 0) {
      slugsByQuestionId.set(questionId, slugs);
    }
  }

  return slugsByQuestionId;
}

async function fetchConceptEmbeddings(slugs, apiKey) {
  const uniqueSlugs = Array.from(new Set(slugs)).filter(
    (slug) => slug !== FALLBACK_CONCEPT_SLUG,
  );

  if (uniqueSlugs.length === 0) {
    return new Map();
  }

  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "waxon",
    },
    body: JSON.stringify({
      model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      input: uniqueSlugs.map(titleCaseSlug),
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Concept embedding request failed: ${response.status} ${errorText.slice(0, 400)}`,
    );
  }

  const body = await response.json();

  if (!Array.isArray(body.data) || body.data.length !== uniqueSlugs.length) {
    throw new Error("Concept embedding response length did not match request.");
  }

  const embeddingsBySlug = new Map();

  for (let index = 0; index < uniqueSlugs.length; index += 1) {
    const embedding = body.data[index]?.embedding;

    if (Array.isArray(embedding) && embedding.length > 0) {
      embeddingsBySlug.set(
        uniqueSlugs[index],
        embedding.map((component) => Number(component)),
      );
    }
  }

  return embeddingsBySlug;
}

async function saveAssignments(pool, assignments, apiKey) {
  const now = Date.now();
  const embeddingsBySlug = await fetchConceptEmbeddings(
    assignments.flatMap((assignment) => assignment.slugs),
    apiKey,
  ).catch((error) => {
    console.warn(error instanceof Error ? error.message : error);
    return new Map();
  });
  let attached = 0;

  for (const assignment of assignments) {
    for (const slug of assignment.slugs) {
      const embedding = embeddingsBySlug.get(slug);
      const tagResult = await pool.query(
        `
          INSERT INTO concept_tags (
            user_id,
            slug,
            active,
            embedding,
            created_at,
            updated_at
          )
          VALUES ($1, $2, true, $3::vector, $4, $4)
          ON CONFLICT (user_id, slug)
          DO UPDATE SET
            active = true,
            embedding = coalesce(concept_tags.embedding, excluded.embedding),
            updated_at = excluded.updated_at
          RETURNING id::text
        `,
        [
          assignment.userId,
          slug,
          embedding ? vectorLiteral(embedding) : null,
          now,
        ],
      );
      const conceptTagId = tagResult.rows[0]?.id;

      if (!conceptTagId) {
        continue;
      }

      const linkResult = await pool.query(
        `
          INSERT INTO question_concept_tags (
            question_id,
            concept_tag_id,
            created_at
          )
          VALUES ($1::uuid, $2::uuid, $3)
          ON CONFLICT DO NOTHING
        `,
        [assignment.questionId, conceptTagId, now],
      );

      attached += linkResult.rowCount ?? 0;
    }
  }

  return attached;
}

async function deactivateLegacyTagsIfSafe(pool, options, legacySlugsByUser) {
  if (options.keepLegacyActive || options.dryRun) {
    return;
  }

  const rows = await loadQuestions(pool, options.userId);
  const remaining = rows.filter((row) => !hasRealConcept(row));

  if (remaining.length > 0) {
    console.log(
      `Keeping legacy tags active because ${remaining.length} questions still have no real concept tag.`,
    );
    if (remaining.length <= 20) {
      for (const row of remaining) {
        console.log(
          [
            `Remaining ${row.questionId}:`,
            row.question.slice(0, 220),
            `current=${row.conceptSlugs.join(", ") || "none"}`,
          ].join(" "),
        );
      }
    }
    return;
  }

  let deactivated = 0;

  for (const [userId, legacySlugs] of legacySlugsByUser) {
    const result = await pool.query(
      `
        UPDATE concept_tags
        SET active = false,
            updated_at = $3
        WHERE user_id = $1
          AND active = true
          AND (
            slug = ANY($2::text[])
            OR slug LIKE 'course-%'
          )
      `,
      [userId, Array.from(legacySlugs), Date.now()],
    );

    deactivated += result.rowCount ?? 0;
  }

  console.log(`Deactivated ${deactivated} legacy course tags.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireOpenRouterApiKey();
  const pool = createDatabasePool(Pool);

  try {
    await assertConceptSchemaExists(pool);

    const legacySlugsByUser = await loadLegacySlugsByUser(pool, options.userId);
    const candidateSlugsByUser = await loadCandidateSlugsByUser(
      pool,
      legacySlugsByUser,
      options.userId,
    );
    const allQuestions = await loadQuestions(pool, options.userId);
    const questions = allQuestions
      .filter((row) => options.force || !hasRealConcept(row))
      .slice(0, options.limit ?? undefined);

    if (questions.length === 0) {
      console.log("No questions need concept backfill.");
      await deactivateLegacyTagsIfSafe(pool, options, legacySlugsByUser);
      return;
    }

    console.log(
      `Generating concept tags for ${questions.length} questions${
        options.force ? " (force)" : ""
      }.`,
    );

    let processed = 0;
    let attached = 0;

    for (const batch of chunks(questions, options.batchSize)) {
      const slugsByQuestionId = await generateConceptSlugs(
        batch,
        candidateSlugsByUser,
        apiKey,
      );
      const assignments = batch.map((row) => {
        const generatedSlugs = (slugsByQuestionId.get(row.questionId) ?? []).filter(
          (slug) => !isLegacySlugForQuestion(row, slug),
        );

        return {
          questionId: row.questionId,
          userId: row.userId,
          slugs: generatedSlugs.length > 0 ? generatedSlugs : [FALLBACK_CONCEPT_SLUG],
        };
      });

      if (options.dryRun) {
        for (const assignment of assignments) {
          console.log(`${assignment.questionId}: ${assignment.slugs.join(", ")}`);
        }
      } else {
        attached += await saveAssignments(pool, assignments, apiKey);
      }

      processed += batch.length;
      console.log(`Processed ${processed}/${questions.length}`);
    }

    if (!options.dryRun) {
      console.log(`Attached ${attached} new question-tag links.`);
      await deactivateLegacyTagsIfSafe(pool, options, legacySlugsByUser);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
