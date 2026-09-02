import pg from "pg";

import {
  buildOpenRouterHeaders,
  OPENROUTER_EMBEDDINGS_URL,
  resolveOpenRouterApiKey,
} from "../shared/openrouter-config.mts";
import { questionSearchVectorLiteral } from "../shared/question-search.mts";
import { tagEmbeddingInput } from "../shared/tag-embedding.mts";
import {
  activeEmbeddingSpace,
  validateEmbedding,
} from "../app/lib/v2/embeddingSpaces.ts";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and keyenv may provide the environment directly.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}
const apiKey = resolveOpenRouterApiKey();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");

const space = activeEmbeddingSpace();
const pool = new pg.Pool({ connectionString });

type TagRow = {
  user_id: string;
  id: string;
  label: string;
  aliases: string[];
  scope_note: string;
};

async function embed(inputs: readonly string[], userId: string): Promise<number[][]> {
  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey!),
    body: JSON.stringify({
      model: space.requestModel,
      dimensions: space.dimensions,
      encoding_format: "float",
      input: inputs,
      user: userId,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Tag embedding request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as {
    data?: Array<{ embedding?: unknown; index?: number }>;
  };
  if (!Array.isArray(parsed.data) || parsed.data.length !== inputs.length) {
    throw new Error("Tag embedding response had the wrong batch size.");
  }
  return [...parsed.data]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((item) => validateEmbedding(item.embedding as number[], space));
}

try {
  const registered = await pool.query<{ key: string }>(
    `SELECT key FROM waxon_v2.embedding_spaces WHERE id = $1`,
    [space.id],
  );
  if (registered.rows[0]?.key !== space.key) {
    throw new Error(`Embedding space ${space.key} is not registered.`);
  }

  const copiedQuestions = await pool.query(
    `INSERT INTO waxon_v2.question_embeddings
       (user_id, space_id, question_id, embedding)
     SELECT user_id, $1, question_id, embedding
       FROM waxon_v2.question_embeddings
      WHERE space_id = 1
     ON CONFLICT DO NOTHING`,
    [space.id],
  );
  const tags = await pool.query<TagRow>(
    `SELECT tag.user_id, tag.id, tag.label, tag.aliases, tag.scope_note
       FROM waxon_v2.tags tag
       LEFT JOIN waxon_v2.tag_embeddings embedding
         ON embedding.user_id = tag.user_id
        AND embedding.tag_id = tag.id
        AND embedding.space_id = $1
      WHERE tag.deleted_at IS NULL
        AND embedding.tag_id IS NULL
      ORDER BY tag.user_id, tag.id`,
    [space.id],
  );

  let embeddedCount = 0;
  const tagsByLearner = Map.groupBy(tags.rows, (tag) => tag.user_id);
  for (const [learnerId, learnerTags] of tagsByLearner) {
    for (let offset = 0; offset < learnerTags.length; offset += 100) {
      const batch = learnerTags.slice(offset, offset + 100);
      const vectors = await embed(
        batch.map((tag) =>
          tagEmbeddingInput({
            label: tag.label,
            aliases: tag.aliases,
            description: tag.scope_note,
          }),
        ),
        learnerId,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [index, tag] of batch.entries()) {
          await client.query(
            `INSERT INTO waxon_v2.tag_embeddings
               (user_id, space_id, tag_id, embedding)
             VALUES ($1, $2, $3, $4::halfvec)
             ON CONFLICT (user_id, space_id, tag_id)
             DO UPDATE SET embedding = EXCLUDED.embedding`,
            [
              tag.user_id,
              space.id,
              tag.id,
              questionSearchVectorLiteral(vectors[index]!),
            ],
          );
        }
        await client.query("COMMIT");
        embeddedCount += batch.length;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  console.log(
    JSON.stringify({
      space: space.key,
      copiedQuestions: copiedQuestions.rowCount,
      embeddedTags: embeddedCount,
    }),
  );
} finally {
  await pool.end();
}
