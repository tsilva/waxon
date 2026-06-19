"use client";

import { ChevronDown } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { MarkdownContent, MarkdownInline } from "@/app/MarkdownContent";
import { formatFormulaMarkdown } from "@/app/lib/markdownFormulaFormatting";
import { SCHEDULED_SCORE_THRESHOLD } from "@/app/lib/scheduler";

export type PreviousAnswerRowStatus = "grading" | "resolved";

export type PreviousAnswerRowProps = {
  id: string;
  question: string;
  status: PreviousAnswerRowStatus;
  score: number | null;
  feedback: string | null;
  correctAnswer?: string | null;
  cost?: number | null;
  timestamp?: number | null;
  timeLabel?: string;
  isExpanded?: boolean;
  detailId?: string;
  questionLabel?: string;
  detailsLabel?: string;
  className?: string;
  leadingContent?: ReactNode;
  questionLabelContent?: ReactNode;
  supportingContent?: ReactNode;
  detailsContent?: ReactNode;
  metaContent?: ReactNode;
  secondaryMetaContent?: ReactNode;
  onToggle?: () => void;
  onDetailsClick?: () => void;
};

function scoreTone(score: number | null) {
  if (score === null) {
    return "neutral";
  }

  if (score >= SCHEDULED_SCORE_THRESHOLD) {
    return "high";
  }

  if (score === SCHEDULED_SCORE_THRESHOLD - 1) {
    return "medium";
  }

  return "low";
}

function formatEvaluationCost(cost: number | null | undefined): string | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost);
}

export function PreviousAnswerScore({
  score,
  className,
  label,
}: {
  score: number | null;
  className?: string;
  label?: string;
}) {
  const displayScore = score === null ? "-" : score;
  const accessibleLabel =
    label ?? (score === null ? "No score" : `Score ${score} out of 10`);

  return (
    <span
      className={`previous-score-shell${className ? ` ${className}` : ""}`}
      aria-label={accessibleLabel}
    >
      <span className={`previous-score score-${scoreTone(score)}`}>
        {displayScore}
      </span>
    </span>
  );
}

export function PreviousAnswerRow({
  id,
  question,
  status,
  score,
  feedback,
  correctAnswer,
  cost = null,
  timestamp = null,
  timeLabel = "Just now",
  isExpanded = false,
  detailId,
  questionLabel = "Question",
  detailsLabel = "More details",
  className,
  leadingContent,
  questionLabelContent,
  supportingContent,
  detailsContent,
  metaContent,
  secondaryMetaContent,
  onToggle,
  onDetailsClick,
}: PreviousAnswerRowProps) {
  const isPending = status === "grading";
  const isInteractive = Boolean(onToggle);
  const evaluationCostLabel = isPending ? null : formatEvaluationCost(cost);
  const rowClassName = [
    "previous-row",
    isPending ? "previous-row-pending" : "previous-row-resolved",
    isExpanded ? "previous-row-open" : "previous-row-collapsed",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const mainContent = (
    <>
      <div className="previous-copy">
        <div className="previous-field previous-question-field">
          <span className="previous-label-row">
            <span className="previous-field-label">{questionLabel}</span>
            {questionLabelContent !== undefined ? (
              <span className="previous-label-content">
                {questionLabelContent}
              </span>
            ) : null}
          </span>
          <MarkdownInline
            as="p"
            className="previous-question"
            enableMath
            text={question}
          />
          {isPending ? (
            supportingContent !== undefined ? (
              supportingContent
            ) : (
              <p
                className="previous-question-feedback previous-question-feedback-pending"
                aria-live="polite"
              >
                Evaluating...
              </p>
            )
          ) : supportingContent !== undefined ? (
            supportingContent
          ) : (
            <MarkdownContent
              className="previous-question-feedback"
              enableMath
              text={feedback ?? "No feedback returned."}
            />
          )}
        </div>

        <div
          className="previous-detail-grid"
          hidden={!isExpanded}
          id={detailId}
        >
          {detailsContent !== undefined ? (
            detailsContent
          ) : (
            <div className="previous-field">
              <span className="previous-field-label">Correct answer</span>
              {correctAnswer ? (
                <MarkdownInline
                  as="p"
                  className="previous-answer"
                  enableMath
                  text={formatFormulaMarkdown(correctAnswer, { style: "math" })}
                />
              ) : (
                <p className="previous-answer previous-answer-empty">
                  No correct answer recorded.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <span className="previous-row-meta">
        {metaContent !== undefined ? (
          metaContent
        ) : (
          <>
            <span className="previous-time-control">
              <time
                className="previous-time"
                dateTime={
                  timestamp ? new Date(timestamp).toISOString() : undefined
                }
              >
                {timeLabel}
              </time>
              {isInteractive ? (
                <ChevronDown className="previous-collapse-icon" aria-hidden="true" />
              ) : null}
            </span>
            {evaluationCostLabel || secondaryMetaContent ? (
              <span className="previous-secondary-meta">
                {secondaryMetaContent}
                {evaluationCostLabel ? (
                  <span
                    className="previous-cost-label"
                    aria-label={`Evaluation cost ${evaluationCostLabel}`}
                  >
                    {evaluationCostLabel}
                  </span>
                ) : null}
              </span>
            ) : null}
          </>
        )}
      </span>
    </>
  );
  const handleMainKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onToggle || event.target !== event.currentTarget) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <li className={rowClassName} key={id}>
      <div className="previous-score-slot">
        {leadingContent !== undefined ? (
          leadingContent
        ) : isPending ? (
          <span className="pending-spinner" aria-hidden="true" />
        ) : (
          <PreviousAnswerScore score={score} />
        )}
      </div>

      {onToggle ? (
        <div
          className="previous-row-main-button"
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={handleMainKeyDown}
          aria-expanded={isExpanded}
          aria-controls={detailId}
        >
          {mainContent}
        </div>
      ) : (
        <div className="previous-row-main-button previous-row-main-static">
          {mainContent}
        </div>
      )}

      {isExpanded && onDetailsClick ? (
        <button
          className="previous-details-link"
          type="button"
          onClick={onDetailsClick}
        >
          {detailsLabel}
        </button>
      ) : null}
    </li>
  );
}
