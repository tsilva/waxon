import assert from "node:assert/strict";
import test from "node:test";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";
import {
  normalizeQuestionSearchEmbedding,
  normalizeQuestionSearchPrompt,
  questionSearchAdvisory,
  questionSearchEmbeddingInput,
  questionSearchPromptHash,
  reciprocalRankFuse,
  resolveQuestionSearchConfig,
} from "../shared/question-search.mts";
import { QUESTION_SEARCH_EVAL_CASES } from "./fixtures/question-search-eval.mts";

test("question-search prompt normalization preserves meaningful case and notation", () => {
  assert.equal(
    normalizeQuestionSearchPrompt("  Why  `HTTP`?\n$A^2$  "),
    "Why `HTTP`? $A^2$",
  );
  assert.equal(
    questionSearchEmbeddingInput("What is RRF?"),
    "Question:\nWhat is RRF?",
  );
  assert.notEqual(
    questionSearchPromptHash("What is HTTP?"),
    questionSearchPromptHash("What is http?"),
  );
});

test("question-search config requires an explicit threshold for hybrid advice", () => {
  assert.deepEqual(resolveQuestionSearchConfig({}), {
    mode: "lexical",
    model: "openai/text-embedding-3-small",
    semanticThreshold: null,
  });
  assert.equal(
    resolveQuestionSearchConfig({
      WAXON_QUESTION_SEARCH_MODE: "hybrid",
      WAXON_QUESTION_SEARCH_SEMANTIC_THRESHOLD: "",
    }).semanticThreshold,
    null,
  );
  assert.deepEqual(
    resolveQuestionSearchConfig({
      WAXON_QUESTION_SEARCH_MODE: "hybrid",
      WAXON_QUESTION_SEARCH_SEMANTIC_THRESHOLD: "0.74",
      QUESTION_SEARCH_EMBEDDING_MODEL: "example/model",
    }),
    { mode: "hybrid", model: "example/model", semanticThreshold: 0.74 },
  );
});

test("question-search embeddings are validated and normalized", () => {
  const vector = Array.from({ length: 512 }, (_, index) =>
    index === 0 ? 3 : index === 1 ? 4 : 0,
  );
  const normalized = normalizeQuestionSearchEmbedding(vector);
  assert.equal(normalized.length, 512);
  assert.equal(normalized[0], 0.6);
  assert.equal(normalized[1], 0.8);
  assert.throws(() => normalizeQuestionSearchEmbedding([1, 2]));
  assert.throws(() => normalizeQuestionSearchEmbedding(Array(512).fill(0)));
});

test("RRF rewards agreement without comparing incompatible raw scores", () => {
  assert.deepEqual(
    reciprocalRankFuse([
      ["lexical-only", "both"],
      ["both", "semantic-only"],
    ]).map((item) => item.id),
    ["both", "lexical-only", "semantic-only"],
  );
});

test("advice is definitive only for exact or complete hybrid search signals", () => {
  assert.equal(
    questionSearchAdvisory({ exact: true, matchCount: 0, semanticComplete: false }),
    "exact_duplicate",
  );
  assert.equal(
    questionSearchAdvisory({ exact: false, matchCount: 1, semanticComplete: false }),
    "review_similar",
  );
  assert.equal(
    questionSearchAdvisory({ exact: false, matchCount: 0, semanticComplete: false }),
    "search_incomplete",
  );
  assert.equal(
    questionSearchAdvisory({ exact: false, matchCount: 0, semanticComplete: true }),
    "no_close_match",
  );
});

test("evaluation fixture contains 120 diverse labeled cases", () => {
  assert.equal(QUESTION_SEARCH_EVAL_CASES.length, 120);
  assert.equal(
    QUESTION_SEARCH_EVAL_CASES.filter((item) => item.label === "same_target")
      .length,
    48,
  );
  assert.equal(
    QUESTION_SEARCH_EVAL_CASES.filter(
      (item) => item.label === "related_distinct",
    ).length,
    48,
  );
  assert.equal(
    QUESTION_SEARCH_EVAL_CASES.filter((item) => item.label === "unrelated")
      .length,
    24,
  );
  const exactCases = QUESTION_SEARCH_EVAL_CASES.filter(
    (item) => item.stratum === "exact_normalization",
  );
  assert.equal(exactCases.length, 12);
  assert.equal(
    exactCases.every(
      (item) => questionPromptKey(item.storedPrompt) === questionPromptKey(item.candidatePrompt),
    ),
    true,
  );
});
