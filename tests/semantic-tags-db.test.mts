import assert from "node:assert/strict";
import test from "node:test";

const TEST_DATABASE_URL = process.env.TAGS_TEST_DATABASE_URL?.trim() ?? "";

function axisVector(axis: number, dimensions = 512): string {
  return `[${Array.from({ length: dimensions }, (_, index) =>
    index === axis ? 1 : 0,
  ).join(",")}]`;
}

test(
  "semantic Tags rank only compatible embeddings within one Learner",
  { skip: TEST_DATABASE_URL ? false : "TAGS_TEST_DATABASE_URL is not set" },
  async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DATABASE_URL_UNPOOLED = TEST_DATABASE_URL;
    const [{ getV2Client }, semantic, tags, service] = await Promise.all([
      import("../app/db/v2/client.ts"),
      import("../app/lib/v2/semanticTags.ts"),
      import("../app/lib/v2/tags.ts"),
      import("../app/lib/v2/service.ts"),
    ]);
    const pool = getV2Client().pool;
    const learnerA = "semantic-tags-a";
    const learnerB = "semantic-tags-b";
    const firstSpace = 1;
    const secondSpace = 2;
    try {
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, 'Semantic Tags A', 'semantic-a@waxon.invalid'),
                ($2, 'Semantic Tags B', 'semantic-b@waxon.invalid')`,
        [learnerA, learnerB],
      );
      await pool.query(
        `INSERT INTO waxon_v2.embedding_spaces (id, key)
         VALUES ($1, 'test:256:topic-v2') ON CONFLICT (id) DO NOTHING`,
        [secondSpace],
      );
      const inserted = await pool.query<{ id: string; prompt: string }>(
        `INSERT INTO waxon_v2.questions
           (user_id, prompt, reference_answer, target_key)
         VALUES ($1, 'Neural network Question', 'Deep learning', 'semantic-neural'),
                ($1, 'Probability Question', 'Statistics', 'semantic-probability'),
                ($1, 'Question without an embedding', 'Missing', 'semantic-missing')
         RETURNING id, prompt`,
        [learnerA],
      );
      const questionByPrompt = new Map(
        inserted.rows.map((row) => [row.prompt, row.id]),
      );
      const tagRows = await pool.query<{ id: string; label: string }>(
        `INSERT INTO waxon_v2.tags
           (user_id, label, normalized_label, scope_note)
         VALUES ($1, 'Deep learning', 'deep learning', 'Questions about deep learning.'),
                ($1, 'Statistics', 'statistics', 'Questions about statistics.')
         RETURNING id, label`,
        [learnerA],
      );
      const tagByLabel = new Map(tagRows.rows.map((row) => [row.label, row.id]));
      const deepLearning = tagByLabel.get("Deep learning")!;
      const statistics = tagByLabel.get("Statistics")!;
      const neural = questionByPrompt.get("Neural network Question")!;
      const probability = questionByPrompt.get("Probability Question")!;

      await pool.query(
        `INSERT INTO waxon_v2.question_embeddings
           (user_id, space_id, question_id, embedding)
         VALUES ($1, $2, $3, $5::halfvec), ($1, $2, $4, $6::halfvec)`,
        [
          learnerA,
          firstSpace,
          neural,
          probability,
          axisVector(0),
          axisVector(1),
        ],
      );
      await pool.query(
        `INSERT INTO waxon_v2.tag_embeddings
           (user_id, space_id, tag_id, embedding)
         VALUES ($1, $2, $3, $5::halfvec), ($1, $2, $4, $6::halfvec)`,
        [
          learnerA,
          firstSpace,
          deepLearning,
          statistics,
          axisVector(0),
          axisVector(1),
        ],
      );
      await pool.query(
        `INSERT INTO waxon_v2.question_embeddings
           (user_id, space_id, question_id, embedding)
         VALUES ($1, $2, $3, $4::halfvec)`,
        [learnerA, secondSpace, neural, axisVector(1, 256)],
      );
      await pool.query(
        `INSERT INTO waxon_v2.tag_embeddings
           (user_id, space_id, tag_id, embedding)
         VALUES ($1, $2, $3, $4::halfvec)`,
        [learnerA, secondSpace, deepLearning, axisVector(1, 256)],
      );

      const nearestTags = await semantic.relatedTags({
        learnerId: learnerA,
        questionIds: [neural],
        limit: 1,
      });
      assert.deepEqual(nearestTags.get(neural), [
        { id: deepLearning, label: "Deep learning" },
      ]);
      assert.deepEqual(
        (
          await semantic.relatedQuestions({
            learnerId: learnerA,
            tagIds: [deepLearning],
          })
        ).questionIds,
        [neural, probability],
      );
      assert.deepEqual(
        (
          await semantic.relatedQuestions({
            learnerId: learnerA,
            tagIds: [deepLearning],
            text: "Neural",
          })
        ).questionIds,
        [neural],
      );
      assert.deepEqual(
        (await service.listLibrary({ userId: learnerA })).questions
          .find(({ id }) => id === neural)
          ?.relatedTags,
        [
          { id: deepLearning, label: "Deep learning" },
          { id: statistics, label: "Statistics" },
        ],
      );
      assert.equal(
        (await service.listLibrary({ userId: learnerA })).questions.some(
          ({ prompt }) => prompt === "Question without an embedding",
        ),
        true,
      );
      assert.deepEqual(
        (await tags.listTags({ userId: learnerA, search: "Deep" })).tags,
        [{ id: deepLearning, label: "Deep learning" }],
      );

      await pool.query(
        `UPDATE waxon_v2.questions SET lifecycle = 'archived'
          WHERE user_id = $1 AND id = $2`,
        [learnerA, probability],
      );
      assert.deepEqual(
        (
          await semantic.relatedQuestions({
            learnerId: learnerA,
            tagIds: [deepLearning],
            lifecycle: "active",
          })
        ).questionIds,
        [neural],
      );

      const paginated = await pool.query<{ id: string }>(
        `INSERT INTO waxon_v2.questions
           (user_id, prompt, reference_answer, target_key)
         SELECT $1, 'Semantic page ' || value, 'Deep learning',
                'semantic-page-' || value
           FROM generate_series(1, 51) value
         RETURNING id`,
        [learnerA],
      );
      await pool.query(
        `INSERT INTO waxon_v2.question_embeddings
           (user_id, space_id, question_id, embedding)
         SELECT $1, $2, id, $3::halfvec
           FROM unnest($4::uuid[]) input(id)`,
        [learnerA, firstSpace, axisVector(0), paginated.rows.map(({ id }) => id)],
      );
      const firstPage = await semantic.relatedQuestions({
        learnerId: learnerA,
        tagIds: [deepLearning],
      });
      assert.equal(firstPage.questionIds.length, 50);
      assert.ok(firstPage.nextCursor);
      const secondPage = await semantic.relatedQuestions({
        learnerId: learnerA,
        tagIds: [deepLearning],
        cursor: firstPage.nextCursor ?? undefined,
      });
      assert.equal(secondPage.nextCursor, null);
      assert.equal(
        new Set([...firstPage.questionIds, ...secondPage.questionIds]).size,
        53,
      );

      const paginatedTags = await pool.query<{ id: string }>(
        `INSERT INTO waxon_v2.tags
           (user_id, label, normalized_label, scope_note)
         SELECT $1, 'Semantic Tag ' || lpad(value::text, 3, '0'),
                'semantic tag ' || lpad(value::text, 3, '0'),
                'Pagination fixture.'
           FROM generate_series(1, 51) value
         RETURNING id`,
        [learnerA],
      );
      await pool.query(
        `INSERT INTO waxon_v2.tag_embeddings
           (user_id, space_id, tag_id, embedding)
         SELECT $1, $2, id, $3::halfvec
           FROM unnest($4::uuid[]) input(id)`,
        [
          learnerA,
          firstSpace,
          axisVector(0),
          paginatedTags.rows.map(({ id }) => id),
        ],
      );
      const firstTagPage = await tags.listTags({
        userId: learnerA,
        search: "Semantic Tag",
      });
      assert.equal(firstTagPage.tags.length, 50);
      assert.ok(firstTagPage.nextCursor);
      const secondTagPage = await tags.listTags({
        userId: learnerA,
        search: "Semantic Tag",
        cursor: firstTagPage.nextCursor ?? undefined,
      });
      assert.equal(secondTagPage.tags.length, 1);
      assert.equal(secondTagPage.nextCursor, null);

      await pool.query(
        `INSERT INTO waxon_v2.tags
           (user_id, label, normalized_label, scope_note)
         VALUES ($1, 'Foreign Tag', 'foreign tag', 'A foreign Tag.')`,
        [learnerB],
      );
      const foreign = await pool.query<{ id: string }>(
        `SELECT id FROM waxon_v2.tags WHERE user_id = $1 LIMIT 1`,
        [learnerB],
      );
      await assert.rejects(
        semantic.relatedQuestions({
          learnerId: learnerA,
          tagIds: [foreign.rows[0]!.id],
        }),
        /active, owned, and embedded/u,
      );

      await pool.query(
        `UPDATE waxon_v2.tags SET deleted_at = now()
          WHERE user_id = $1 AND id = $2`,
        [learnerA, deepLearning],
      );
      await assert.rejects(
        semantic.relatedQuestions({
          learnerId: learnerA,
          tagIds: [deepLearning],
        }),
        /active, owned, and embedded/u,
      );
    } finally {
      await pool.query(`DELETE FROM waxon_v2.users WHERE id = ANY($1::text[])`, [
        [learnerA, learnerB],
      ]);
      await pool.query(`DELETE FROM waxon_v2.embedding_spaces WHERE id = $1`, [
        secondSpace,
      ]);
      await pool.end();
    }
  },
);
