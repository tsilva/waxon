import assert from "node:assert/strict";
import test from "node:test";
import {
  extractChatCompletionText,
  extractOpenRouterChatText,
} from "../shared/openrouter-chat-text.mjs";
import {
  DEFAULT_EMBEDDING_MODEL,
  resolveEmbeddingModel,
} from "../shared/openrouter-config.mjs";
import {
  buildEmbeddingSource,
  decodeOpenRouterEmbeddings,
  DEDUPE_EMBEDDING_DIMENSIONS,
  DEDUPE_EMBEDDING_KIND,
  DEDUPE_SOURCE_VERSION,
  hashEmbeddingSource,
} from "../shared/embedding-contract.mjs";
import { vectorLiteral } from "../shared/vector-literal.mjs";
import {
  buildConciseAnswerRequest,
  parseConciseAnswerResults,
} from "../shared/concise-answer-contract.mjs";

test("resolveEmbeddingModel trims overrides and falls back for blank values", () => {
  assert.equal(resolveEmbeddingModel({}), DEFAULT_EMBEDDING_MODEL);
  assert.equal(
    resolveEmbeddingModel({ EMBEDDING_MODEL: "openai/text-embedding-3-small" }),
    "openai/text-embedding-3-small",
  );
  assert.equal(resolveEmbeddingModel({ EMBEDDING_MODEL: "" }), DEFAULT_EMBEDDING_MODEL);
  assert.equal(resolveEmbeddingModel({ EMBEDDING_MODEL: "  custom/model  " }), "custom/model");
});

test("shared embedding source preserves live and backfill identity", () => {
  const source = buildEmbeddingSource({
    question: "  What is PPO? ",
    conciseAnswer: " Proximal policy optimization. ",
    kind: DEDUPE_EMBEDDING_KIND,
    sourceVersion: DEDUPE_SOURCE_VERSION,
  });

  assert.equal(
    source,
    "version: 1\nkind: dedupe_v1\nQuestion: What is PPO?\nExpected answer: Proximal policy optimization.",
  );
  assert.match(hashEmbeddingSource(source), /^[a-f0-9]{64}$/u);
});

test("shared embedding decoder enforces count, dimensions, and finite values", () => {
  const embedding = Array.from(
    { length: DEDUPE_EMBEDDING_DIMENSIONS },
    (_, index) => index / 100,
  );

  assert.deepEqual(
    decodeOpenRouterEmbeddings([{ embedding }], {
      expectedCount: 1,
      expectedDimensions: DEDUPE_EMBEDDING_DIMENSIONS,
    }),
    [embedding],
  );
  assert.throws(
    () => decodeOpenRouterEmbeddings([], { expectedCount: 1 }),
    /expected 1/u,
  );
  assert.throws(
    () => decodeOpenRouterEmbeddings([{ embedding: [Number.NaN] }]),
    /non-finite/u,
  );
});

test("vectorLiteral preserves the app and script pgvector serialization", () => {
  assert.equal(vectorLiteral([]), "[]");
  assert.equal(vectorLiteral([0.25, -1, 3]), "[0.25,-1,3]");
});

test("shared concise-answer contract keeps live and backfill payloads aligned", () => {
  const questions = [{ id: "q-1", question: "What is PPO?" }];
  const request = buildConciseAnswerRequest({
    model: "test/model",
    questions,
  });

  assert.equal(request.model, "test/model");
  assert.equal(request.max_tokens, 540);
  assert.match(String(request.messages[1]?.content), /What is PPO\?/u);
  assert.deepEqual(
    parseConciseAnswerResults(
      questions,
      JSON.stringify({
        answers: [{ id: "q-1", conciseAnswer: "  Proximal   policy optimization.  " }],
      }),
    ),
    [
      {
        id: "q-1",
        question: "What is PPO?",
        conciseAnswer: "Proximal policy optimization.",
      },
    ],
  );
});

test("extractChatCompletionText preserves app trimming and compact text-part joins", () => {
  assert.equal(
    extractChatCompletionText({
      choices: [{ message: { content: "  learner-facing text  " } }],
    }),
    "learner-facing text",
  );
  assert.equal(
    extractChatCompletionText({
      choices: [
        {
          message: {
            content: [
              { text: "  first " },
              { content: "ignored" },
              "also ignored",
              { text: "second  " },
            ],
          },
        },
      ],
    }),
    "first second",
  );
  assert.equal(extractChatCompletionText({ choices: [] }), "");
  assert.throws(() => extractChatCompletionText(null), TypeError);
});

test("extractOpenRouterChatText preserves script whitespace, keys, and newline joins", () => {
  assert.equal(
    extractOpenRouterChatText({
      choices: [{ message: { content: "  script text  " } }],
    }),
    "  script text  ",
  );
  assert.equal(
    extractOpenRouterChatText({
      choices: [
        {
          message: {
            content: [
              "first",
              { text: "second" },
              { content: "third" },
              { text: "", content: "ignored" },
              null,
            ],
          },
        },
      ],
    }),
    "first\nsecond\nthird",
  );
  assert.equal(extractOpenRouterChatText({ choices: [] }), "");
});
