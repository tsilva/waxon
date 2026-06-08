import assert from "node:assert/strict";
import test from "node:test";
import { extractCompleteJsonObjectsFromArrayProperty } from "../app/lib/streamedJsonArray.ts";

test("extractCompleteJsonObjectsFromArrayProperty extracts only complete streamed objects", () => {
  const partialText = [
    '{"questions":[',
    '{"question":"What is weight decay?","conciseAnswer":"L2 penalty","questionProvenance":"next regularization target"},',
    '{"question":"Why can',
  ].join("");

  assert.deepEqual(extractCompleteJsonObjectsFromArrayProperty(partialText, "questions"), [
    {
      question: "What is weight decay?",
      conciseAnswer: "L2 penalty",
      questionProvenance: "next regularization target",
    },
  ]);
});

test("extractCompleteJsonObjectsFromArrayProperty handles braces inside strings", () => {
  const partialText =
    '{"questions":[{"question":"What does f(x) = {x} mean in this notation?","conciseAnswer":"a placeholder expression","questionProvenance":"next notation target"}]}';

  assert.equal(
    extractCompleteJsonObjectsFromArrayProperty(partialText, "questions").length,
    1,
  );
});

test("extractCompleteJsonObjectsFromArrayProperty extracts compact generated question keys", () => {
  assert.deepEqual(
    extractCompleteJsonObjectsFromArrayProperty(
      '{"questions":[{"q":"What does weight decay penalize?","a":"Large weights","p":"next regularization target"}]}',
      "questions",
    ),
    [
      {
        q: "What does weight decay penalize?",
        a: "Large weights",
        p: "next regularization target",
      },
    ],
  );
});
