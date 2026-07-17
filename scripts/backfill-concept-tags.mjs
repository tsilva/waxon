import { Pool, neonConfig } from "@neondatabase/serverless";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  FALLBACK_CONCEPT_SLUG,
  isScaffoldingConceptSlug,
  isUsefulConceptSlug,
  normalizeConceptSlug,
} from "../shared/concept-slug.mts";
import {
  decodeOpenRouterEmbeddings,
  DEDUPE_EMBEDDING_DIMENSIONS,
} from "../shared/embedding-contract.mts";
import { extractJsonObject } from "../shared/json-object.mts";
import {
  loadPromptTemplate,
  renderPromptTemplate,
} from "../shared/prompt-templates.mts";
import {
  chunks,
  configureNeonWebSocket,
  createDatabasePool,
  extractOpenRouterChatText,
  fetchOpenRouterJson,
  loadLocalEnvFiles,
  OPENROUTER_CHAT_URL,
  OPENROUTER_EMBEDDINGS_URL,
  openRouterChatModel,
  requireOpenRouterApiKey,
  resolveEmbeddingModel,
  vectorLiteral,
} from "./lib/runtime.mjs";

loadLocalEnvFiles();
configureNeonWebSocket(neonConfig);

const DEFAULT_BATCH_SIZE = 10;

function parseArgs(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      "batch-size": {
        type: "string",
        default: String(DEFAULT_BATCH_SIZE),
      },
      "dry-run": {
        type: "boolean",
        default: false,
      },
      force: {
        type: "boolean",
        default: false,
      },
      limit: {
        type: "string",
      },
      "user-id": {
        type: "string",
        default: "",
      },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = {
    batchSize: Number(values["batch-size"]),
    dryRun: values["dry-run"],
    force: values.force,
    limit: values.limit === undefined ? null : Number(values.limit),
    userId: values["user-id"].trim(),
  };

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

async function loadCandidateSlugsByUser(pool, userId) {
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
    if (
      !isUsefulConceptSlug(slug) ||
      isScaffoldingConceptSlug(slug)
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
  return renderPromptTemplate(loadPromptTemplate("backfill-concept-tags-user.md"), {
    questionsJson: JSON.stringify({
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
  });
}

async function generateConceptSlugs(batch, candidateSlugsByUser, apiKey) {
  const body = await fetchOpenRouterJson(OPENROUTER_CHAT_URL, {
    apiKey,
    errorPrefix: "Concept backfill request failed",
    errorTextLength: 400,
    body: {
      model: openRouterChatModel(),
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: Math.min(4096, 1_000 + batch.length * 350),
      messages: [
        {
          role: "system",
          content: loadPromptTemplate("backfill-concept-tags-system.md"),
        },
        {
          role: "user",
          content: buildPrompt(batch, candidateSlugsByUser),
        },
      ],
    },
  });
  const content = extractOpenRouterChatText(body);
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

  const body = await fetchOpenRouterJson(OPENROUTER_EMBEDDINGS_URL, {
    apiKey,
    errorPrefix: "Concept embedding request failed",
    errorTextLength: 400,
    body: {
      model: resolveEmbeddingModel(),
      input: uniqueSlugs.map(titleCaseSlug),
      encoding_format: "float",
    },
  });

  const embeddings = decodeOpenRouterEmbeddings(body.data, {
    expectedCount: uniqueSlugs.length,
    expectedDimensions: DEDUPE_EMBEDDING_DIMENSIONS,
  });

  const embeddingsBySlug = new Map();

  for (let index = 0; index < uniqueSlugs.length; index += 1) {
    embeddingsBySlug.set(uniqueSlugs[index], embeddings[index]);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = requireOpenRouterApiKey();
  const pool = createDatabasePool(Pool);

  try {
    await assertConceptSchemaExists(pool);

    const candidateSlugsByUser = await loadCandidateSlugsByUser(
      pool,
      options.userId,
    );
    const allQuestions = await loadQuestions(pool, options.userId);
    const questions = allQuestions
      .filter((row) => options.force || !hasRealConcept(row))
      .slice(0, options.limit ?? undefined);

    if (questions.length === 0) {
      console.log("No questions need concept backfill.");
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
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
