import { DEDUPE_EMBEDDING_KIND } from "../../shared/embedding-contract.mts";
import { resolveEmbeddingModel } from "../../shared/openrouter-config.mts";
import type { QuestionEmbeddingProjection } from "./postgresStore";
import type {
  KnowledgeEmbeddingPlot,
  KnowledgeEmbeddingPlotPoint,
} from "./reviewTypes";

export const KNOWLEDGE_EMBEDDING_PLOT_LIMIT = 500;

type ReadQuestionEmbeddingProjections = (input: {
  embeddingModel?: string;
  embeddingKind?: string;
  currentOnly?: boolean;
  limit?: number;
  offset?: number;
  userId?: string;
}) => Promise<QuestionEmbeddingProjection[]>;

function normalizeProjectionValue(value: number, min: number, max: number): number {
  if (max - min <= Number.EPSILON) {
    return 0.5;
  }

  return (value - min) / (max - min);
}

export function normalizeKnowledgeEmbeddingPlotPoints(
  rows: Array<{
    question: string;
    lastScore: number | null;
    projectionX: number;
    projectionY: number;
  }>,
): KnowledgeEmbeddingPlotPoint[] {
  if (rows.length === 0) {
    return [];
  }

  if (rows.length === 1) {
    return [
      {
        question: rows[0]?.question ?? "",
        lastScore: rows[0]?.lastScore ?? null,
        x: 0.5,
        y: 0.5,
      },
    ];
  }

  const xValues = rows.map((point) => point.projectionX);
  const yValues = rows.map((point) => point.projectionY);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return rows.map((point) => ({
    question: point.question,
    lastScore: point.lastScore,
    x: normalizeProjectionValue(point.projectionX, minX, maxX),
    y: normalizeProjectionValue(point.projectionY, minY, maxY),
  }));
}

export function buildKnowledgeEmbeddingPlot(
  questions: QuestionEmbeddingProjection[],
): KnowledgeEmbeddingPlot {
  const modelCounts = new Map<string, number>();
  const projectedRows = questions.filter(
    (question) =>
      question.embeddingModel &&
      question.embeddingKind === DEDUPE_EMBEDDING_KIND &&
      question.isCurrent &&
      question.projectionX !== null &&
      question.projectionY !== null,
  );

  for (const embedding of projectedRows) {
    const embeddingModel = embedding.embeddingModel;

    if (!embeddingModel) {
      continue;
    }

    modelCounts.set(
      embeddingModel,
      (modelCounts.get(embeddingModel) ?? 0) + 1,
    );
  }

  const model = Array.from(modelCounts.entries()).sort(
    ([modelA, countA], [modelB, countB]) =>
      countB - countA || modelA.localeCompare(modelB),
  )[0]?.[0] ?? null;

  if (!model) {
    return {
      model: null,
      totalQuestions: questions.length,
      embeddedQuestions: 0,
      points: [],
    };
  }

  const selectedEmbeddings = projectedRows
    .map((question) => {
      return question.embeddingModel === model &&
        question.projectionX !== null &&
        question.projectionY !== null
        ? {
            question: question.question,
            lastScore: question.lastScore,
            projectionX: question.projectionX,
            projectionY: question.projectionY,
          }
        : null;
    })
    .filter(
      (item): item is {
        question: string;
        lastScore: number | null;
        projectionX: number;
        projectionY: number;
      } =>
        item !== null &&
        Number.isFinite(item.projectionX) &&
        Number.isFinite(item.projectionY),
    );

  return {
    model,
    totalQuestions: questions.length,
    embeddedQuestions: selectedEmbeddings.length,
    points: normalizeKnowledgeEmbeddingPlotPoints(selectedEmbeddings),
  };
}

export async function knowledgeEmbeddingPlotStatus(
  input: {
    userId: string;
    limit?: number;
    offset?: number;
  },
  readQuestionEmbeddingProjections: ReadQuestionEmbeddingProjections,
): Promise<KnowledgeEmbeddingPlot> {
  const limit = Math.min(
    KNOWLEDGE_EMBEDDING_PLOT_LIMIT,
    Math.max(
      0,
      Math.floor(input.limit ?? KNOWLEDGE_EMBEDDING_PLOT_LIMIT),
    ),
  );
  const questions = await readQuestionEmbeddingProjections({
    userId: input.userId,
    embeddingModel: resolveEmbeddingModel(),
    embeddingKind: DEDUPE_EMBEDDING_KIND,
    currentOnly: true,
    limit,
    offset: input.offset,
  });

  return buildKnowledgeEmbeddingPlot(questions);
}
