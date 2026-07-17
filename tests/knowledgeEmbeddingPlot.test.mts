import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeEmbeddingPlot,
  KNOWLEDGE_EMBEDDING_PLOT_LIMIT,
  knowledgeEmbeddingPlotStatus,
  normalizeKnowledgeEmbeddingPlotPoints,
} from "../app/lib/knowledgeEmbeddingPlot.ts";

test("normalizes plot points across each projection axis", () => {
  assert.deepEqual(
    normalizeKnowledgeEmbeddingPlotPoints([
      { question: "A", lastScore: 4, projectionX: -2, projectionY: 10 },
      { question: "B", lastScore: null, projectionX: 2, projectionY: 20 },
      { question: "C", lastScore: 9, projectionX: 0, projectionY: 15 },
    ]),
    [
      { question: "A", lastScore: 4, x: 0, y: 0 },
      { question: "B", lastScore: null, x: 1, y: 1 },
      { question: "C", lastScore: 9, x: 0.5, y: 0.5 },
    ],
  );
});

test("centers a single point and a collapsed axis", () => {
  assert.deepEqual(
    normalizeKnowledgeEmbeddingPlotPoints([
      { question: "Only", lastScore: null, projectionX: 7, projectionY: 7 },
    ]),
    [{ question: "Only", lastScore: null, x: 0.5, y: 0.5 }],
  );
  assert.deepEqual(
    normalizeKnowledgeEmbeddingPlotPoints([
      { question: "A", lastScore: null, projectionX: 3, projectionY: 1 },
      { question: "B", lastScore: null, projectionX: 3, projectionY: 5 },
    ]),
    [
      { question: "A", lastScore: null, x: 0.5, y: 0 },
      { question: "B", lastScore: null, x: 0.5, y: 1 },
    ],
  );
});

test("builds the plot from the dominant current dedupe model", () => {
  const plot = buildKnowledgeEmbeddingPlot([
    {
      question: "A",
      lastScore: 3,
      embeddingModel: "model-b",
      embeddingKind: "dedupe_v1",
      isCurrent: true,
      projectionX: 0,
      projectionY: 0,
    },
    {
      question: "B",
      lastScore: 8,
      embeddingModel: "model-a",
      embeddingKind: "dedupe_v1",
      isCurrent: true,
      projectionX: 2,
      projectionY: 2,
    },
    {
      question: "C",
      lastScore: null,
      embeddingModel: "model-a",
      embeddingKind: "dedupe_v1",
      isCurrent: true,
      projectionX: 4,
      projectionY: 4,
    },
    {
      question: "No current projection",
      lastScore: null,
      embeddingModel: null,
      embeddingKind: null,
      isCurrent: null,
      projectionX: null,
      projectionY: null,
    },
  ]);

  assert.equal(plot.model, "model-a");
  assert.equal(plot.totalQuestions, 4);
  assert.equal(plot.embeddedQuestions, 2);
  assert.deepEqual(plot.points, [
    { question: "B", lastScore: 8, x: 0, y: 0 },
    { question: "C", lastScore: null, x: 1, y: 1 },
  ]);
});

test("owns and applies the map query limit", async () => {
  let receivedLimit: number | undefined;

  const plot = await knowledgeEmbeddingPlotStatus(
    { userId: "user-1", limit: 2_000 },
    async (input) => {
      receivedLimit = input.limit;
      return [];
    },
  );

  assert.equal(receivedLimit, KNOWLEDGE_EMBEDDING_PLOT_LIMIT);
  assert.deepEqual(plot, {
    model: null,
    totalQuestions: 0,
    embeddedQuestions: 0,
    points: [],
  });
});
