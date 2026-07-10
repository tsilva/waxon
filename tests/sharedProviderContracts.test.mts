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
import { vectorLiteral } from "../shared/vector-literal.mjs";

test("resolveEmbeddingModel preserves the existing environment fallback semantics", () => {
  assert.equal(resolveEmbeddingModel({}), DEFAULT_EMBEDDING_MODEL);
  assert.equal(
    resolveEmbeddingModel({ EMBEDDING_MODEL: "openai/text-embedding-3-small" }),
    "openai/text-embedding-3-small",
  );
  assert.equal(resolveEmbeddingModel({ EMBEDDING_MODEL: "" }), "");
  assert.equal(resolveEmbeddingModel({ EMBEDDING_MODEL: "  custom/model  " }), "  custom/model  ");
});

test("vectorLiteral preserves the app and script pgvector serialization", () => {
  assert.equal(vectorLiteral([]), "[]");
  assert.equal(vectorLiteral([0.25, -1, 3]), "[0.25,-1,3]");
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
