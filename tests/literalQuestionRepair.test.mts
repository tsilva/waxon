import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSynthesisDocument,
  parseArgs,
  sectionForOffset,
  sourceSections,
} from "../scripts/repair-literal-question-import.mts";

test("literal question repair requires an explicit source id", () => {
  assert.throws(() => parseArgs([]), /source-id/u);
  assert.deepEqual(
    parseArgs([
      "--source-id",
      "55c17f4a-0c55-48dd-a087-f84c3b7d3297",
      "--expected-count",
      "250",
      "--apply",
    ]),
    {
      sourceId: "55c17f4a-0c55-48dd-a087-f84c3b7d3297",
      expectedCount: 250,
      apply: true,
      mergeHeld: false,
    },
  );
});

test("source sections preserve authored examination order", () => {
  const body = [
    "# Exam",
    "## Purpose",
    "Intro",
    "## I. Foundations",
    "1. First?",
    "## II. Optimization",
    "2. Second?",
  ].join("\n");
  const sections = sourceSections(body);
  assert.deepEqual(sections.map((section) => section.title), [
    "I. Foundations",
    "II. Optimization",
  ]);
  assert.equal(sectionForOffset(sections, body.indexOf("First?")), "I. Foundations");
  assert.equal(sectionForOffset(sections, body.indexOf("Second?")), "II. Optimization");
});

test("synthesis evidence offsets select only the stored reference answer", () => {
  const synthesis = buildSynthesisDocument([
    { prompt: "First?", answer: "First answer.", section: "I. Foundations", order: 0 },
    { prompt: "Second?", answer: "Second answer.", section: "I. Foundations", order: 1 },
  ]);
  assert.equal(synthesis.spans.length, 2);
  for (const span of synthesis.spans) {
    assert.equal(synthesis.body.slice(span.startOffset, span.endOffset), span.quote);
  }
  assert.equal(synthesis.spans[0]?.quote, "First answer.");
  assert.equal(synthesis.spans[1]?.quote, "Second answer.");
});
