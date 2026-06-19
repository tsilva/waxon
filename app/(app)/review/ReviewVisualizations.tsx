"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { MarkdownInline } from "@/app/MarkdownContent";
import type {
  KnowledgeEmbeddingPlot as KnowledgeEmbeddingPlotResponse,
  KnowledgeEmbeddingPlotPoint,
  ReviewHistoryEntry,
  ReviewQueueItem,
} from "@/app/lib/reviewTypes";
import { formatDueBadge } from "./reviewFormatting";

type HoveredEmbeddingPoint = KnowledgeEmbeddingPlotPoint & {
  statusLabel: string;
  scoreLabel: string | null;
  tooltipLeftPx: number;
  tooltipTopPx: number;
  arrowLeftPx: number;
  verticalPlacement: "above" | "below";
};

export function ScoreChart({ entries }: { entries: ReviewHistoryEntry[] }) {
  const width = 520;
  const height = 190;
  const padding = 28;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const points = entries.map((entry, index) => {
    const x =
      entries.length === 1
        ? padding + plotWidth / 2
        : padding + (index / (entries.length - 1)) * plotWidth;
    const y = padding + ((10 - entry.score) / 10) * plotHeight;

    return {
      ...entry,
      x,
      y,
    };
  });
  const path =
    points.length > 1
      ? points
          .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
          .join(" ")
      : "";

  if (entries.length === 0) {
    return (
      <div className="stats-chart-empty">
        Score history will appear after the first graded review.
      </div>
    );
  }

  return (
    <svg
      className="stats-chart"
      role="img"
      aria-label="Previous score history"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding}
        y2={padding}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={padding + plotHeight / 2}
        y2={padding + plotHeight / 2}
      />
      <line
        className="stats-chart-grid"
        x1={padding}
        x2={width - padding}
        y1={height - padding}
        y2={height - padding}
      />
      {path ? <path className="stats-chart-line" d={path} /> : null}
      {points.map((point, index) => (
        <g key={`${point.ts}-${index}`}>
          <circle className="stats-chart-point" cx={point.x} cy={point.y} r="5" />
          <text className="stats-chart-label" x={point.x} y={point.y - 10}>
            {point.score}
          </text>
        </g>
      ))}
      <text className="stats-chart-axis" x="8" y={padding + 4}>
        10
      </text>
      <text className="stats-chart-axis" x="14" y={height - padding + 4}>
        0
      </text>
    </svg>
  );
}

export function KnowledgeEmbeddingPlot({
  plot,
  reviewQueue,
}: {
  plot: KnowledgeEmbeddingPlotResponse;
  reviewQueue: ReviewQueueItem[];
}) {
  const [hoveredPoint, setHoveredPoint] =
    useState<HoveredEmbeddingPoint | null>(null);
  const plotCanvasRef = useRef<HTMLDivElement | null>(null);
  const width = 720;
  const height = 270;
  const padding = 26;
  const statusByQuestion = useMemo(
    () => new Map(reviewQueue.map((item) => [item.question, item])),
    [reviewQueue],
  );

  function getPointMetadata(
    point: KnowledgeEmbeddingPlotPoint,
  ): Pick<HoveredEmbeddingPoint, "statusLabel" | "scoreLabel"> {
    const queueItem = statusByQuestion.get(point.question);

    return {
      statusLabel: queueItem
        ? queueItem.status === "now"
          ? "Due now"
          : `Due in ${formatDueBadge(queueItem)}`
        : "Not scheduled",
      scoreLabel:
        queueItem?.lastScore === null || queueItem?.lastScore === undefined
          ? null
          : `Last score ${queueItem.lastScore}/10`,
    };
  }

  function showPoint(point: KnowledgeEmbeddingPlotPoint) {
    const x = padding + point.x * (width - padding * 2);
    const y = padding + (1 - point.y) * (height - padding * 2);
    const canvasRect = plotCanvasRef.current?.getBoundingClientRect();
    const canvasWidth = canvasRect?.width ?? width;
    const canvasHeight = canvasRect?.height ?? height;
    const renderedX = (x / width) * canvasWidth;
    const renderedY = (y / height) * canvasHeight;
    const isCompact = canvasWidth < 520;
    const horizontalInset = isCompact ? 10 : 14;
    const arrowInset = 14;
    const tooltipWidth = Math.min(
      isCompact ? 280 : 340,
      canvasWidth - (isCompact ? 20 : 28),
    );
    const minTooltipLeft = horizontalInset;
    const maxTooltipLeft = Math.max(
      minTooltipLeft,
      canvasWidth - tooltipWidth - horizontalInset,
    );
    const tooltipLeft = Math.min(
      Math.max(renderedX - tooltipWidth / 2, minTooltipLeft),
      maxTooltipLeft,
    );
    const metadata = getPointMetadata(point);

    setHoveredPoint({
      ...point,
      ...metadata,
      arrowLeftPx: Math.min(
        Math.max(renderedX - tooltipLeft, arrowInset),
        tooltipWidth - arrowInset,
      ),
      tooltipLeftPx: tooltipLeft,
      tooltipTopPx: renderedY,
      verticalPlacement: y / height < 0.32 ? "below" : "above",
    });
  }

  return (
    <section className="embedding-plot-panel" aria-label="KnowledgeBase embedding map">
      <div className="embedding-plot-header">
        <div>
          <h2>Embedding map</h2>
          <p>
            {plot.embeddedQuestions}/{plot.totalQuestions} cards
            {plot.model ? ` · ${plot.model}` : ""}
          </p>
        </div>
      </div>

      {plot.points.length === 0 ? (
        <div className="embedding-plot-empty">
          Embeddings will appear here after backfill.
        </div>
      ) : (
        <div
          className="embedding-plot-canvas"
          ref={plotCanvasRef}
          onMouseLeave={() => setHoveredPoint(null)}
        >
          <svg
            className="embedding-plot"
            role="img"
            aria-label="KnowledgeBase questions plotted by embedding similarity"
            viewBox={`0 0 ${width} ${height}`}
          >
            <line
              className="embedding-plot-grid"
              x1={padding}
              x2={width - padding}
              y1={height / 2}
              y2={height / 2}
            />
            <line
              className="embedding-plot-grid"
              x1={width / 2}
              x2={width / 2}
              y1={padding}
              y2={height - padding}
            />
            <rect
              className="embedding-plot-frame"
              x={padding}
              y={padding}
              width={width - padding * 2}
              height={height - padding * 2}
              rx="10"
            />
            {plot.points.map((point) => {
              const queueItem = statusByQuestion.get(point.question);
              const tone =
                point.lastScore === null
                  ? "unanswered"
                  : queueItem?.status === "now"
                    ? "now"
                    : "scheduled";
              const x = padding + point.x * (width - padding * 2);
              const y = padding + (1 - point.y) * (height - padding * 2);

              return (
                <g
                  className={`embedding-plot-point point-${tone}`}
                  key={point.question}
                  onFocus={() => showPoint(point)}
                  onBlur={() => setHoveredPoint(null)}
                  onMouseEnter={() => showPoint(point)}
                >
                  <circle cx={x} cy={y} r="7" />
                  <circle
                    className="embedding-plot-hit-area"
                    cx={x}
                    cy={y}
                    r="15"
                  />
                </g>
              );
            })}
          </svg>

          {hoveredPoint ? (
            <div
              className={`embedding-tooltip tooltip-y-${hoveredPoint.verticalPlacement}`}
              style={
                {
                  "--tooltip-arrow-left": `${hoveredPoint.arrowLeftPx}px`,
                  left: `${hoveredPoint.tooltipLeftPx}px`,
                  top: `${hoveredPoint.tooltipTopPx}px`,
                } as CSSProperties
              }
              role="status"
            >
              <MarkdownInline
                as="p"
                className="embedding-tooltip-question"
                text={hoveredPoint.question}
              />
              <span className="embedding-tooltip-meta">
                {hoveredPoint.statusLabel}
                {hoveredPoint.scoreLabel ? ` · ${hoveredPoint.scoreLabel}` : ""}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
