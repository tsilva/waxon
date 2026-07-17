import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeQuestionDraft,
  normalizeQuestionDrafts,
} from "../app/lib/questionDraft.ts";

test("normalizeQuestionDraft canonicalizes shared aliases and whitespace", () => {
  const cases = [
    {
      input: {
        q: "  What   is  weight decay?  ",
        a: "  A penalty\nfor large weights ",
        p: "  regularization   target ",
        c: " weight-decay ",
      },
      expected: {
        question: "What is weight decay?",
        questionIdentity: "what-is-weight-decay",
        conciseAnswer: "A penalty for large weights",
        questionProvenance: "regularization target",
        proposedConceptSlugs: ["weight-decay"],
        sourceText: "",
      },
    },
    {
      input: "  What   is entropy? ",
      expected: {
        question: "What is entropy?",
        questionIdentity: "what-is-entropy",
        conciseAnswer: "",
        questionProvenance: "",
        proposedConceptSlugs: [],
        sourceText: "",
      },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(normalizeQuestionDraft(input), expected);
  }
});

test("normalizeQuestionDraft normalizes and deduplicates concept-slug arrays", () => {
  assert.deepEqual(
    normalizeQuestionDraft({
      question: "What is an optimizer?",
      proposedConceptSlugs: [
        " optimizer ",
        "",
        null,
        "gradient   descent",
        "optimizer",
      ],
    })?.proposedConceptSlugs,
    ["optimizer", "gradient descent"],
  );

  assert.deepEqual(
    normalizeQuestionDraft({
      question: "What is momentum?",
      conceptSlugs: ["momentum", " optimization "],
      conceptSlug: "ignored-when-an-array-is-present",
    })?.proposedConceptSlugs,
    ["momentum", "optimization"],
  );

  assert.deepEqual(
    normalizeQuestionDraft({
      question: "What is a scheduler?",
      proposedConceptSlugs: [],
      conceptSlug: "ignored-when-an-array-is-present",
    })?.proposedConceptSlugs,
    [],
  );
});

test("normalizeQuestionDraft exposes the persistence slug as shared identity", () => {
  const first = normalizeQuestionDraft("What is weight decay?");
  const punctuationVariant = normalizeQuestionDraft("What is weight decay?!");

  assert.equal(first?.questionIdentity, punctuationVariant?.questionIdentity);
});

test("normalizeQuestionDraft applies source-specific limits before identity", () => {
  assert.deepEqual(
    normalizeQuestionDraft(
      {
        q: "  Alpha   beta?  ",
        a: "  concise answer ",
        provenance: " generation frontier ",
        conceptSlug: "long-concept",
        sourceText: "  line one\nline two  ",
      },
      {
        question: 5,
        conciseAnswer: 7,
        questionProvenance: 10,
        conceptSlug: 4,
        sourceText: 8,
      },
    ),
    {
      question: "Alpha",
      questionIdentity: "alpha",
      conciseAnswer: "concise",
      questionProvenance: "generation",
      proposedConceptSlugs: ["long"],
      sourceText: "line one",
    },
  );
});

test("normalizeQuestionDraft rejects values without a usable question", () => {
  for (const value of [null, 42, {}, { q: "   " }]) {
    assert.equal(normalizeQuestionDraft(value), null);
  }
});

test("normalizeQuestionDrafts deduplicates while preserving ingestion metadata", () => {
  assert.deepEqual(
    normalizeQuestionDrafts([
      {
        question: "  What is PPO? ",
        conciseAnswer: " Proximal policy optimization. ",
        questionProvenance: " paper ",
        proposedConceptSlugs: ["policy-optimization"],
        sourceText: "source excerpt",
      },
      { question: "What is PPO?", questionProvenance: "duplicate" },
    ]),
    [
      {
        question: "What is PPO?",
        questionIdentity: "what-is-ppo",
        conciseAnswer: "Proximal policy optimization.",
        questionProvenance: "paper",
        proposedConceptSlugs: ["policy-optimization"],
        sourceText: "source excerpt",
      },
    ],
  );
});
