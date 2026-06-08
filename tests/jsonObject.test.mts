import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject } from "../app/lib/jsonObject.ts";

test("extractJsonObject accepts raw newlines inside JSON string values", () => {
  const result = extractJsonObject('{"memoryPatch":[{"body":"- first\n- second"}]}');

  assert.deepEqual(result, {
    memoryPatch: [{ body: "- first\n- second" }],
  });
});

test("extractJsonObject accepts fenced text around JSON with raw string newlines", () => {
  const result = extractJsonObject(
    'Here is JSON:\n{"questions":[],"memoryPatch":[{"body":"- ア (a): strong\n- イ (i): strong"}]}\nDone.',
  );

  assert.deepEqual(result, {
    questions: [],
    memoryPatch: [{ body: "- ア (a): strong\n- イ (i): strong" }],
  });
});

test("extractJsonObject ignores malformed text after the first balanced object", () => {
  const result = extractJsonObject(
    '{"complete":false,"questions":[{"question":"Next?","conciseAnswer":"yes"}]}]}\n)"}]}\n-',
  );

  assert.deepEqual(result, {
    complete: false,
    questions: [{ question: "Next?", conciseAnswer: "yes" }],
  });
});
