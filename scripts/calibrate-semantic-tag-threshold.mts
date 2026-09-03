import pg from "pg";

import { activeEmbeddingSpace } from "../app/lib/v2/embeddingSpaces.ts";
import referenceSet from "../reference/semantic-tag-reference-set.json" with {
  type: "json",
};

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // CI and Vercel may provide the environment directly.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}
const space = activeEmbeddingSpace();
const pool = new pg.Pool({ connectionString });

const expectedTagIdsByQuestion = new Map(
  referenceSet.questions.map(({ questionId, expectedTagIds }) => [
    questionId,
    new Set(expectedTagIds),
  ]),
);
if (expectedTagIdsByQuestion.size === 0) {
  throw new Error("The semantic Tag reference set is empty.");
}

type CandidateRow = {
  question_index: number;
  question_id: string;
  prompt: string;
  reference_answer: string;
  candidate_index: number;
  tag_id: string;
  semantic_rank: number;
  label: string;
  aliases: string[];
  description: string;
  similarity: number | string;
  lexical_match: boolean;
};

type Candidate = {
  index: number;
  tagId: string;
  label: string;
  aliases: string[];
  description: string;
  similarity: number;
  lexicalMatch: boolean;
  semanticRank: number;
};

type EvaluationQuestion = {
  id: number;
  questionId: string;
  prompt: string;
  answerStandard: string;
  candidates: Candidate[];
};

type Judgment = { question: number; relevant: number[] };

function metrics(
  questions: readonly EvaluationQuestion[],
  judgments: readonly Judgment[],
  semanticThreshold: number,
  lexicalRescueFloor = 0.4,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let questionsWithTags = 0;
  let literalMatches = 0;
  let literalSelections = 0;
  let lexicalRescues = 0;
  let semanticOnlySelections = 0;
  let rejectedLowSimilarityMentions = 0;
  for (const [questionIndex, question] of questions.entries()) {
    const relevant = new Set(judgments[questionIndex]!.relevant);
    const shown = question.candidates
      .filter(
        (candidate) =>
          candidate.similarity >= semanticThreshold ||
          (candidate.lexicalMatch && candidate.similarity >= lexicalRescueFloor),
      )
      .sort(
        (left, right) =>
          Number(
            right.lexicalMatch && right.similarity >= lexicalRescueFloor,
          ) -
            Number(left.lexicalMatch && left.similarity >= lexicalRescueFloor) ||
          right.similarity - left.similarity ||
          left.label.localeCompare(right.label),
      )
      .slice(0, 3);
    const shownIndexes = new Set(shown.map(({ index }) => index));
    if (shown.length > 0) questionsWithTags += 1;
    literalMatches += question.candidates.filter(
      ({ lexicalMatch }) => lexicalMatch,
    ).length;
    rejectedLowSimilarityMentions += question.candidates.filter(
      (candidate) =>
        candidate.lexicalMatch && candidate.similarity < lexicalRescueFloor,
    ).length;
    literalSelections += shown.filter(({ lexicalMatch }) => lexicalMatch).length;
    lexicalRescues += shown.filter(
      (candidate) =>
        candidate.lexicalMatch && candidate.similarity < semanticThreshold,
    ).length;
    semanticOnlySelections += shown.filter(
      ({ lexicalMatch }) => !lexicalMatch,
    ).length;
    for (const candidate of question.candidates) {
      const isShown = shownIndexes.has(candidate.index);
      const isRelevant = relevant.has(candidate.index);
      if (isShown && isRelevant) truePositive += 1;
      else if (isShown) falsePositive += 1;
      else if (isRelevant) falseNegative += 1;
    }
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  return {
    semanticThreshold,
    lexicalRescueFloor,
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall),
    shown: truePositive + falsePositive,
    questionsWithTags,
    truePositive,
    falsePositive,
    falseNegative,
    literalMatches,
    literalSelections,
    lexicalRescues,
    semanticOnlySelections,
    rejectedLowSimilarityMentions,
  };
}

try {
  const result = await pool.query<CandidateRow>(
    `WITH questions AS (
       SELECT question.user_id, question.id, question.prompt, question.reference_answer,
              embedding.embedding,
              row_number() OVER (ORDER BY question.id)::int - 1 AS question_index
         FROM waxon_v2.questions question
         JOIN waxon_v2.question_embeddings embedding
          ON embedding.user_id = question.user_id
          AND embedding.question_id = question.id
          AND embedding.space_id = $1
        WHERE question.id = ANY($2::uuid[])
    ), scored AS (
       SELECT question.question_index, question.id AS question_id,
              question.prompt, question.reference_answer,
              tag.id AS tag_id, tag.label, tag.aliases,
              tag.scope_note AS description,
              1 - (tag_embedding.embedding <=> question.embedding) AS similarity,
              row_number() OVER (
                PARTITION BY question.id
                ORDER BY tag_embedding.embedding <=> question.embedding, tag.id
              )::int - 1 AS semantic_rank,
              EXISTS (
                SELECT 1
                  FROM unnest(array_prepend(tag.label, tag.aliases)) AS term(value)
                 WHERE to_tsvector('simple', question.prompt)
                       @@ phraseto_tsquery('simple', term.value)
              ) AS lexical_match
         FROM questions question
         JOIN waxon_v2.tag_embeddings tag_embedding
           ON tag_embedding.user_id = question.user_id
          AND tag_embedding.space_id = $1
         JOIN waxon_v2.tags tag
           ON tag.user_id = tag_embedding.user_id
          AND tag.id = tag_embedding.tag_id
          AND tag.deleted_at IS NULL
     ), candidates AS (
       SELECT *, row_number() OVER (
         PARTITION BY question_index ORDER BY semantic_rank
       )::int - 1 AS candidate_index
         FROM scored
     )
     SELECT * FROM candidates
      ORDER BY question_index, candidate_index`,
    [space.id, [...expectedTagIdsByQuestion.keys()]],
  );
  const grouped = Map.groupBy(result.rows, (row) => row.question_index);
  const questions = [...grouped.entries()].map(([id, rows]) => ({
    id,
    questionId: rows[0]!.question_id,
    prompt: rows[0]!.prompt,
    answerStandard: rows[0]!.reference_answer,
    candidates: rows.map((row) => ({
      index: row.candidate_index,
      tagId: row.tag_id,
      label: row.label,
      aliases: row.aliases,
      description: row.description,
      similarity: Number(row.similarity),
      lexicalMatch: row.lexical_match,
      semanticRank: row.semantic_rank,
    })),
  }));
  if (questions.length === 0) {
    throw new Error("Calibration found no embedded reference Questions.");
  }
  const unembeddedReferenceQuestions =
    expectedTagIdsByQuestion.size - questions.length;

  const judgments: Judgment[] = questions.map((question, questionIndex) => {
    const expectedTagIds = expectedTagIdsByQuestion.get(question.questionId)!;
    const judgment = {
      question: questionIndex,
      relevant: question.candidates.flatMap((candidate) =>
        expectedTagIds.has(candidate.tagId) ? [candidate.index] : [],
      ),
    };
    if (judgment.relevant.length !== expectedTagIds.size) {
      throw new Error(
        `Reference Question ${question.questionId} contains an inactive or unembedded Tag.`,
      );
    }
    return judgment;
  });
  const thresholds = [
    ...new Set([
      0,
      ...questions.flatMap(({ candidates }) =>
        candidates.map(({ similarity }) => similarity),
      ),
    ]),
  ].sort((left, right) => left - right);
  const allMetrics = thresholds.map((threshold) =>
    metrics(questions, judgments, threshold, 0.4),
  );
  const precisionFirst = allMetrics
    .filter(({ precision }) => precision >= 0.85)
    .sort(
      (left, right) =>
        right.recall - left.recall ||
        left.semanticThreshold - right.semanticThreshold,
    )[0];
  const bestF1 = [...allMetrics].sort(
    (left, right) => right.f1 - left.f1 || right.precision - left.precision,
  )[0];
  const checkpoints = [0.45, 0.475, 0.5, 0.51, 0.525, 0.55].map((threshold) =>
    metrics(questions, judgments, threshold, 0.4),
  );
  console.log(
    JSON.stringify(
      {
        space: space.key,
        referenceAuthor: referenceSet.authoredBy,
        questions: questions.length,
        unembeddedReferenceQuestions,
        judgedCandidates: questions.reduce(
          (count, question) => count + question.candidates.length,
          0,
        ),
        relevantCandidates: judgments.reduce(
          (count, judgment) => count + judgment.relevant.length,
          0,
        ),
        precisionFirst,
        bestF1,
        checkpoints,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
