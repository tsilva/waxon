import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTIVE_EMBEDDING_SPACE_KEY,
  activeEmbeddingSpace,
  embeddingSpaceForKey,
  validateEmbedding,
} from "../app/lib/v2/embeddingSpaces.ts";
import {
  MAX_RELATED_TAGS,
  MIN_LEXICAL_RESCUE_SIMILARITY,
  MIN_RELATED_TAG_SIMILARITY,
  relatedQuestions,
  relatedTags,
} from "../app/lib/v2/semanticTags.ts";
import { tagEmbeddingInput } from "../shared/tag-embedding.mts";

test("the active semantic space fixes model, dimensions, and metric", () => {
  assert.deepEqual(activeEmbeddingSpace(), {
    id: 2,
    key: "openai:text-embedding-3-small:512:topic-v2",
    dimensions: 512,
    metric: "cosine",
    requestModel: "openai/text-embedding-3-small",
  });
  assert.equal(
    embeddingSpaceForKey(ACTIVE_EMBEDDING_SPACE_KEY).id,
    activeEmbeddingSpace().id,
  );
  assert.throws(() => embeddingSpaceForKey("unknown"), /not supported/u);
});

test("Tag embedding input puts normalized aliases before the label and description", () => {
  assert.equal(
    tagEmbeddingInput({
      label: " Proximal  Policy Optimization ",
      aliases: ["PPO", "ppo", "Proximal Policy Optimization"],
      description: " On-policy   optimization. ",
    }),
    "PPO. Proximal Policy Optimization.\nOn-policy optimization.",
  );
});

test("embedding writes validate dimensions, finiteness, and magnitude", () => {
  const normalized = validateEmbedding([3, 4, ...Array(510).fill(0)]);
  assert.equal(normalized.length, 512);
  assert.equal(normalized[0], 0.6);
  assert.equal(normalized[1], 0.8);
  assert.throws(() => validateEmbedding([1, 2]), /512 dimensions/u);
  assert.throws(
    () => validateEmbedding([Number.NaN, ...Array(511).fill(0)]),
    /finite/u,
  );
  assert.throws(() => validateEmbedding(Array(512).fill(0)), /non-zero/u);
});

test("related Tag display uses the calibrated hybrid cutoffs", () => {
  assert.equal(MAX_RELATED_TAGS, 3);
  assert.equal(MIN_RELATED_TAG_SIMILARITY, 0.51);
  assert.equal(MIN_LEXICAL_RESCUE_SIMILARITY, 0.4);
});

test("hybrid retrieval uses Prompt-only simple phrase matching and stable tiers", async () => {
  const source = await readFile(
    new URL("../app/lib/v2/semanticTags.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /to_tsvector\('simple', question\.prompt\)/u);
  assert.match(source, /ARRAY\([\s\S]*phraseto_tsquery\('simple', term\.value\)/u);
  assert.match(source, /array_prepend\(tag\.label, tag\.aliases\)/u);
  assert.match(source, /prompt_document @@ ANY\(tag\.lexical_queries\)/u);
  assert.match(source, /ORDER BY lexical_priority DESC, distance, tag_id/u);
  assert.match(source, /ORDER BY lexical_tier, distance, question_id/u);
  assert.match(source, /hybrid-lexical-semantic-v1/u);
});

test("a semantic cursor cannot be reused for another query", async () => {
  await assert.rejects(
    relatedQuestions({
      learnerId: "learner-a",
      tagIds: ["00000000-0000-4000-8000-000000000001"],
      cursor: Buffer.from(JSON.stringify({ questionId: "bad" })).toString(
        "base64url",
      ),
    }),
    /cursor is invalid/u,
  );
});

test("semantic query boundaries reject oversized batches before database work", async () => {
  const ids = Array.from(
    { length: 51 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  await assert.rejects(
    relatedTags({ learnerId: "learner-a", questionIds: ids }),
    /at most 50 Questions/u,
  );
  await assert.rejects(
    relatedQuestions({ learnerId: "learner-a", tagIds: ids.slice(0, 11) }),
    /between 1 and 10 valid Tags/u,
  );
});

test("Library exposes semantic Tags without assignment management", async () => {
  const [library, review, libraryRoute, tagRoute, semanticModule] =
    await Promise.all([
      readFile(
        new URL(
          "../app/(app)/library/LibraryPageClient.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/(app)/review/ReviewApp.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/v2/library/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/v2/tags/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/lib/v2/semanticTags.ts", import.meta.url),
        "utf8",
      ),
    ]);

  assert.match(library, /aria-label=\{tagIds\.length > 0 \? `Filter by Tags, \$\{tagIds\.length\} selected` : "Filter by Tags"\}/u);
  assert.match(library, /<Tags aria-hidden="true" \/>/u);
  assert.match(library, /\{tagIds\.length > 0 \? <span>\{tagIds\.length\} selected<\/span> : null\}/u);
  assert.doesNotMatch(library, /: "Filter by Tags"\}<\/summary>/u);
  assert.match(library, /Search Tags/u);
  assert.match(library, /relatedTags/u);
  assert.match(library, /Predicted Tags/u);
  assert.match(library, /Codex reference/u);
  assert.match(library, /Codex Reference Tags/u);
  assert.match(library, /question\.referenceTags !== null/u);
  assert.match(library, /Load more/u);
  assert.doesNotMatch(library, /Untagged|Manage Tags|Edit Question Tags/u);
  assert.match(libraryRoute, /searchParams\.getAll\("tag"\)/u);
  assert.doesNotMatch(libraryRoute, /update_tags|untagged/u);
  assert.doesNotMatch(tagRoute, /export async function (POST|PATCH|DELETE)/u);
  assert.doesNotMatch(
    semanticModule,
    /requestQuestionSearchEmbeddings|embedQuestionSearchPrompts|fetch\(/u,
  );
  assert.doesNotMatch(review, /relatedTags|Filter by Tags/u);
});

test("semantic Tag calibration uses the Codex-authored reference set", async () => {
  const [referenceSource, calibration] = await Promise.all([
    readFile(
      new URL("../reference/semantic-tag-reference-set.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../scripts/calibrate-semantic-tag-threshold.mts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const reference = JSON.parse(referenceSource) as {
    authoredBy?: unknown;
    judgmentMethod?: unknown;
    questions?: Array<{ questionId: string; expectedTagIds: string[] }>;
  };

  assert.equal(reference.authoredBy, "Codex");
  assert.match(String(reference.judgmentMethod), /manual full-catalog review/u);
  assert.equal(reference.questions?.length, 254);
  assert.equal(
    new Set(reference.questions?.map(({ questionId }) => questionId)).size,
    reference.questions?.length,
  );
  assert.ok(
    reference.questions?.every(
      ({ expectedTagIds }) =>
        expectedTagIds.length <= 3 &&
        new Set(expectedTagIds).size === expectedTagIds.length,
    ),
  );
  assert.match(calibration, /expectedTagIdsByQuestion/u);
  assert.doesNotMatch(calibration, /OPENROUTER|requestJudgments|fetch\(/u);
});

test("the forward migration preserves compatible vectors and removes assignments", async () => {
  const migration = await readFile(
    new URL("../drizzle-v2/0003_semantic_tag_retrieval.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /INSERT INTO "waxon_v2"\."question_embeddings"[\s\S]*FROM "waxon_v2"\."question_search_embeddings"/u,
  );
  assert.match(
    migration,
    /INSERT INTO "waxon_v2"\."tag_embeddings_semantic"[\s\S]*FROM "waxon_v2"\."tag_embeddings"/u,
  );
  assert.match(migration, /openai\/text-embedding-3-small/u);
  for (const retired of [
    "question_automatic_tags",
    "question_tag_overrides",
    "tag_aliases",
  ]) {
    assert.match(migration, new RegExp(`DROP TABLE .*${retired}`, "u"));
  }
  assert.doesNotMatch(migration, /DROP TABLE "waxon_v2"\."questions"/u);
});

test("the enriched Tag migration preserves Question vectors and seeds aliases", async () => {
  const migration = await readFile(
    new URL("../drizzle-v2/0004_quiet_doctor_octopus.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "aliases" text\[\]/u);
  assert.match(migration, /topic-v2/u);
  assert.match(
    migration,
    /INSERT INTO "waxon_v2"\."question_embeddings"[\s\S]*WHERE "space_id" = 1/u,
  );
  assert.match(
    migration,
    /'Proximal Policy Optimization', ARRAY\['PPO'\]/u,
  );
});
