"use client";

import Link from "next/link";
import { libraryTagHref } from "@/app/lib/libraryTagNavigation";
import type {
  EvaluationPhase,
  QuestionAttempt,
  ReviewHistoryEntry,
} from "@/app/lib/reviewTypes";
import type { QuestionBankItem } from "@/app/lib/questionBank";
import { MarkdownContent, MarkdownInline } from "@/app/MarkdownContent";
import { PreviousAnswerScore } from "@/app/PreviousAnswerRow";
import { ScoreChart } from "@/app/(app)/review/ReviewVisualizations";
import { formatDurationBadge } from "@/app/(app)/review/reviewFormatting";

export type QuestionAnswerHistoryEntry = {
  id: string;
  rawAnswer: string;
  answerSummary: string | null;
  score: number | null;
  justification: string | null;
  correctAnswer: string | null;
  traceId: string | null;
  submittedAt: number;
  resolvedAt: number | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number | null;
};

export type QuestionDetailsModel = {
  questionId: string | null;
  question: string;
  reviewHistory: ReviewHistoryEntry[];
  answerHistory: QuestionAnswerHistoryEntry[];
  attempts: number;
  averageScore: number | null;
  bestScore: number | null;
  lastScore: number | null;
  lastReviewedAt: number | null;
  nextDue: number | null;
  msUntilDue: number | null;
  dueStatus: "now" | "scheduled" | "unknown";
  pendingCount: number;
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  conciseAnswer: string | null;
  lastJustification: string | null;
  conceptSlugs: string[];
};

export function buildPersistedQuestionDetails(
  question: QuestionBankItem,
  attempts: QuestionAttempt[],
  now: number,
): QuestionDetailsModel {
  const orderedAttempts = [...attempts].sort(
    (left, right) => left.resolvedAt - right.resolvedAt,
  );
  const reviewHistory = orderedAttempts.map((attempt) => ({
    ts: attempt.resolvedAt,
    score: attempt.score,
  }));
  const scoreTotal = reviewHistory.reduce(
    (total, entry) => total + entry.score,
    0,
  );

  return {
    questionId: question.questionId,
    question: question.question,
    reviewHistory,
    answerHistory: [...orderedAttempts].reverse().map((attempt) => ({
      id: String(attempt.id),
      rawAnswer: attempt.rawAnswer,
      answerSummary: attempt.answerSummary || null,
      score: attempt.score,
      justification: attempt.justification || null,
      correctAnswer: attempt.correctAnswer,
      traceId: null,
      submittedAt: attempt.submittedAt,
      resolvedAt: attempt.resolvedAt,
      status: "resolved",
      phase: null,
      lastActivityAt: attempt.resolvedAt,
    })),
    attempts: orderedAttempts.length,
    averageScore:
      orderedAttempts.length > 0 ? scoreTotal / orderedAttempts.length : null,
    bestScore:
      orderedAttempts.length > 0
        ? Math.max(...orderedAttempts.map((attempt) => attempt.score))
        : null,
    lastScore: orderedAttempts.at(-1)?.score ?? null,
    lastReviewedAt: orderedAttempts.at(-1)?.resolvedAt ?? null,
    nextDue: question.nextDue,
    msUntilDue: question.nextDue - now,
    dueStatus: question.nextDue <= now ? "now" : "scheduled",
    pendingCount: 0,
    generatedFromQuestion: null,
    questionProvenance: question.questionProvenance,
    conciseAnswer: question.conciseAnswer,
    lastJustification: orderedAttempts.at(-1)?.justification || null,
    conceptSlugs: question.conceptSlugs,
  };
}

function formatEvaluationPhase(phase: EvaluationPhase | null): string {
  switch (phase) {
    case "queued":
      return "Queued for evaluation";
    case "evaluating-answer":
      return "Waiting for evaluator";
    case "saving-evaluation":
      return "Saving evaluation";
    case "finalizing":
      return "Finalizing evaluation";
    default:
      return "Evaluating in background";
  }
}

function formatEvaluationActivity(
  lastActivityAt: number | null,
  currentTime: number,
): string {
  if (lastActivityAt === null) {
    return "Activity pending";
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((currentTime - lastActivityAt) / 1000),
  );
  if (elapsedSeconds < 2) return "Active now";
  if (elapsedSeconds < 60) return `Active ${elapsedSeconds}s ago`;
  return `Active ${Math.floor(elapsedSeconds / 60)}m ago`;
}

function formatReviewDate(timestamp: number | null): string {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatNextDue(details: QuestionDetailsModel): string {
  if (details.nextDue === null || details.msUntilDue === null) return "Unknown";
  if (details.msUntilDue <= 0) return "Due now";
  return `In ${formatDurationBadge(details.msUntilDue)}`;
}

export function QuestionDetailsDialog({
  details,
  currentTime,
  canViewAdmin,
  isLoading = false,
  kicker = "Question details",
  onClose,
}: {
  details: QuestionDetailsModel;
  currentTime: number;
  canViewAdmin: boolean;
  isLoading?: boolean;
  kicker?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="stats-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="stats-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-details-title"
      >
        <div className="stats-modal-header">
          <div>
            <p className="stats-modal-kicker">{kicker}</p>
            <div id="question-details-title">
              <MarkdownInline
                as="h2"
                className="stats-modal-title"
                enableMath
                text={details.question}
              />
            </div>
            <p className="stats-modal-question-id">
              <span>Question ID:</span>
              <code>{details.questionId ?? "Unavailable"}</code>
            </p>
          </div>
          <button
            className="stats-modal-close"
            type="button"
            aria-label="Close question details"
            onClick={onClose}
          />
        </div>

        <div className="stats-grid" aria-label="Question summary metrics">
          <div className="stats-tile"><span>Attempts</span><strong>{details.attempts}</strong></div>
          <div className="stats-tile"><span>Average</span><strong>{details.averageScore === null ? "N/A" : `${details.averageScore.toFixed(1)}/10`}</strong></div>
          <div className="stats-tile"><span>Best</span><strong>{details.bestScore === null ? "N/A" : `${details.bestScore}/10`}</strong></div>
          <div className="stats-tile"><span>Last</span><strong>{details.lastScore === null ? "N/A" : `${details.lastScore}/10`}</strong></div>
          <div className="stats-tile"><span>Next due</span><strong>{formatNextDue(details)}</strong></div>
          <div className="stats-tile"><span>Pending</span><strong>{details.pendingCount}</strong></div>
        </div>

        <div className="stats-chart-panel">
          <div className="stats-section-heading">
            <h3>Previous scores</h3>
            <span>{isLoading ? "Loading..." : `Last reviewed ${formatReviewDate(details.lastReviewedAt)}`}</span>
          </div>
          <ScoreChart entries={details.reviewHistory} />
        </div>

        <div className="stats-history-panel">
          <div className="stats-section-heading"><h3>Answer history</h3><span>{details.dueStatus}</span></div>
          {isLoading ? (
            <p className="stats-empty">Loading history...</p>
          ) : details.answerHistory.length === 0 ? (
            <p className="stats-empty">No answers recorded yet.</p>
          ) : (
            <ol className="stats-history-list">
              {details.answerHistory.map((entry) => {
                const isPending = entry.status === "grading";
                return (
                  <li className={`stats-history-row ${isPending ? "stats-history-row-pending" : "stats-history-row-resolved"}`} key={entry.id}>
                    <div className="stats-history-score-slot">{isPending ? <span className="pending-spinner" aria-hidden="true" /> : <PreviousAnswerScore score={entry.score} />}</div>
                    <div className="stats-history-copy">
                      <div className="previous-field stats-history-answer-field"><span className="previous-field-label">Answer</span><p className="stats-history-answer">{entry.rawAnswer || "(blank)"}</p></div>
                      {entry.answerSummary && entry.answerSummary !== entry.rawAnswer ? <div className="previous-field"><span className="previous-field-label">Summary</span><p className="stats-history-summary">{entry.answerSummary}</p></div> : null}
                      <div className="previous-field"><span className="previous-field-label">Evaluation</span>{entry.justification ? <p className="stats-history-summary">{entry.justification}</p> : <p className="stats-history-summary stats-history-summary-muted">{isPending ? `${formatEvaluationPhase(entry.phase)}... ${formatEvaluationActivity(entry.lastActivityAt, currentTime)}` : "No feedback returned."}</p>}</div>
                    </div>
                    <div className="stats-history-row-meta">
                      <time className="previous-time" dateTime={new Date(entry.resolvedAt ?? entry.submittedAt).toISOString()}>{formatReviewDate(entry.resolvedAt ?? entry.submittedAt)}</time>
                      <span className="stats-history-status">{isPending ? formatEvaluationPhase(entry.phase) : "Resolved"}</span>
                      {canViewAdmin && entry.traceId ? <Link className="stats-history-trace-link" href={`/admin/traces/${encodeURIComponent(entry.traceId)}`}>View trace</Link> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {details.conciseAnswer ? <div className="stats-feedback"><span>Answer</span><MarkdownContent className="stats-feedback-copy" enableMath text={details.conciseAnswer} /></div> : null}
          {details.lastJustification ? <div className="stats-feedback"><span>Latest feedback</span><MarkdownContent className="stats-feedback-copy" enableMath text={details.lastJustification} /></div> : null}
          {details.generatedFromQuestion ? <div className="stats-feedback"><span>Generated from</span><MarkdownContent className="stats-feedback-copy" enableMath text={details.generatedFromQuestion} /></div> : null}
          {details.questionProvenance ? <div className="stats-feedback"><span>Provenance</span><MarkdownContent className="stats-feedback-copy" enableMath text={details.questionProvenance} /></div> : null}
          <div className="stats-feedback">
            <span>Concepts</span>
            {details.conceptSlugs.length > 0 ? <div className="stats-concept-list">{details.conceptSlugs.map((slug) => <Link className="stats-concept-chip stats-concept-chip-link" href={libraryTagHref(slug)} key={slug} onClick={onClose}>#{slug}</Link>)}</div> : <p className="stats-empty">No concepts tagged.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
