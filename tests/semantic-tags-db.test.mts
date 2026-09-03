import assert from "node:assert/strict";
import test from "node:test";

const TEST_DATABASE_URL = process.env.TAGS_TEST_DATABASE_URL?.trim() ?? "";

function axisVector(axis: number, dimensions = 512): string {
  return `[${Array.from({ length: dimensions }, (_, index) =>
    index === axis ? 1 : 0,
  ).join(",")}]`;
}

function cosineVector(
  components: ReadonlyArray<readonly [axis: number, value: number]>,
  dimensions = 512,
): string {
  const vector = Array(dimensions).fill(0) as number[];
  for (const [axis, value] of components) vector[axis] = value;
  return `[${vector.join(",")}]`;
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
    const firstSpace = 2;
    const secondSpace = 101;
    try {
      const lexical = await pool.query<{
        acronym_once: boolean;
        acronym_repeated: boolean;
        phrase_case_folded: boolean;
        phrase_not_consecutive: boolean;
        whole_token_boundary: boolean;
        no_stemming: boolean;
      }>(
        `SELECT
           to_tsvector('simple', 'PPO')
             @@ phraseto_tsquery('simple', 'ppo') AS acronym_once,
           to_tsvector('simple', 'PPO, PPO, and PPO')
             @@ phraseto_tsquery('simple', 'ppo') AS acronym_repeated,
           to_tsvector('simple', 'PROXIMAL policy optimization, explained')
             @@ phraseto_tsquery('simple', 'Proximal Policy Optimization')
               AS phrase_case_folded,
           to_tsvector('simple', 'proximal stochastic policy optimization')
             @@ phraseto_tsquery('simple', 'proximal policy optimization')
               AS phrase_not_consecutive,
           to_tsvector('simple', 'PPOptimizer')
             @@ phraseto_tsquery('simple', 'PPO') AS whole_token_boundary,
           to_tsvector('simple', 'network')
             @@ phraseto_tsquery('simple', 'networks') AS no_stemming`,
      );
      assert.deepEqual(lexical.rows[0], {
        acronym_once: true,
        acronym_repeated: true,
        phrase_case_folded: true,
        phrase_not_consecutive: false,
        whole_token_boundary: false,
        no_stemming: false,
      });

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
        [{ id: deepLearning, label: "Deep learning" }],
      );

      const hybridQuestions = await pool.query<{ id: string; prompt: string }>(
        `INSERT INTO waxon_v2.questions
           (user_id, prompt, reference_answer, target_key)
         VALUES
           ($1, 'What is a typical combined PPO loss?', 'Policy, value, and entropy terms.', 'hybrid-ppo-acronym'),
           ($1, 'How does proximal policy optimization clip its objective?', 'It bounds the policy update.', 'hybrid-ppo-expanded'),
           ($1, 'Which optimizer is used here?', 'PPO is used.', 'hybrid-answer-only'),
           ($1, 'What does PPOptimizer return?', 'An optimizer.', 'hybrid-token-boundary'),
           ($1, 'Why was PPO mentioned incidentally?', 'It was background only.', 'hybrid-low-similarity')
         RETURNING id, prompt`,
        [learnerA],
      );
      const hybridQuestionByPrompt = new Map(
        hybridQuestions.rows.map((row) => [row.prompt, row.id]),
      );
      const hybridTags = await pool.query<{ id: string; label: string }>(
        `INSERT INTO waxon_v2.tags
           (user_id, label, normalized_label, aliases, scope_note)
         VALUES
           ($1, 'Proximal Policy Optimization', 'proximal policy optimization', ARRAY['PPO'], 'Questions about the PPO reinforcement-learning algorithm.'),
           ($1, 'Policy Gradient Methods', 'policy gradient methods', ARRAY[]::text[], 'Questions about policy-gradient methods.')
         RETURNING id, label`,
        [learnerA],
      );
      const hybridTagByLabel = new Map(
        hybridTags.rows.map((row) => [row.label, row.id]),
      );
      const ppo = hybridTagByLabel.get("Proximal Policy Optimization")!;
      const policyGradient = hybridTagByLabel.get("Policy Gradient Methods")!;
      const acronymQuestion = hybridQuestionByPrompt.get(
        "What is a typical combined PPO loss?",
      )!;
      const expandedQuestion = hybridQuestionByPrompt.get(
        "How does proximal policy optimization clip its objective?",
      )!;
      const answerOnlyQuestion = hybridQuestionByPrompt.get(
        "Which optimizer is used here?",
      )!;
      const boundaryQuestion = hybridQuestionByPrompt.get(
        "What does PPOptimizer return?",
      )!;
      const lowSimilarityQuestion = hybridQuestionByPrompt.get(
        "Why was PPO mentioned incidentally?",
      )!;
      await pool.query(
        `INSERT INTO waxon_v2.tag_embeddings
           (user_id, space_id, tag_id, embedding)
         VALUES ($1, $2, $3, $5::halfvec), ($1, $2, $4, $6::halfvec)`,
        [
          learnerA,
          firstSpace,
          ppo,
          policyGradient,
          axisVector(2),
          axisVector(3),
        ],
      );
      await pool.query(
        `INSERT INTO waxon_v2.question_embeddings
           (user_id, space_id, question_id, embedding)
         VALUES
           ($1, $2, $3, $8::halfvec),
           ($1, $2, $4, $8::halfvec),
           ($1, $2, $5, $9::halfvec),
           ($1, $2, $6, $9::halfvec),
           ($1, $2, $7, $10::halfvec)`,
        [
          learnerA,
          firstSpace,
          acronymQuestion,
          expandedQuestion,
          answerOnlyQuestion,
          boundaryQuestion,
          lowSimilarityQuestion,
          cosineVector([
            [2, 0.45],
            [3, 0.89],
            [4, Math.sqrt(1 - 0.45 ** 2 - 0.89 ** 2)],
          ]),
          cosineVector([
            [2, 0.45],
            [4, Math.sqrt(1 - 0.45 ** 2)],
          ]),
          cosineVector([
            [2, 0.3],
            [4, Math.sqrt(1 - 0.3 ** 2)],
          ]),
        ],
      );

      for (const questionId of [acronymQuestion, expandedQuestion]) {
        assert.deepEqual(
          (await semantic.relatedTags({
            learnerId: learnerA,
            questionIds: [questionId],
            limit: 1,
          })).get(questionId),
          [{ id: ppo, label: "Proximal Policy Optimization" }],
        );
      }
      for (const questionId of [
        answerOnlyQuestion,
        boundaryQuestion,
        lowSimilarityQuestion,
      ]) {
        assert.equal(
          (await semantic.relatedTags({
            learnerId: learnerA,
            questionIds: [questionId],
          })).get(questionId)?.some(({ id }) => id === ppo),
          false,
        );
      }
      const ppoQuestions = (
        await semantic.relatedQuestions({
          learnerId: learnerA,
          tagIds: [ppo],
          limit: 10,
        })
      ).questionIds;
      assert.ok(ppoQuestions.indexOf(acronymQuestion) < ppoQuestions.indexOf(answerOnlyQuestion));
      assert.ok(ppoQuestions.indexOf(expandedQuestion) < ppoQuestions.indexOf(answerOnlyQuestion));
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
        58,
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
