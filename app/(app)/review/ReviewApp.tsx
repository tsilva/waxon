"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Flag,
  LoaderCircle,
  Settings2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AnswerComposer } from "@/app/AnswerComposer";
import { MarkdownContent, MarkdownInline } from "@/app/MarkdownContent";
import { ReviewToolbar } from "@/app/ReviewToolbar";
import { useToolbarState } from "@/app/ToolbarState";
import { reviewIntervalLabel } from "@/app/lib/reviewIntervalLabel";
import { reviewHandoffMarkdown } from "@/app/lib/reviewHandoffMarkdown";
import { ReviewFlagDialog } from "./ReviewFlagDialog";
import type {
  V2LearnerSettings,
  V2RecallResult,
  V2ReviewAnswer,
  V2ReviewQuestion,
  V2ReviewQueueResponse,
} from "@/app/lib/v2/types";

const RECALL_RESULT_DISPLAY: Record<
  V2RecallResult,
  { label: string; symbol: string }
> = {
  incorrect: { label: "Incorrect", symbol: "C" },
  partial: { label: "Partial", symbol: "B" },
  correct: { label: "Correct", symbol: "A" },
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Waxon could not complete that action.");
  }
  return body as T;
}

function recallResultLabel(result: V2RecallResult | null): string {
  return result ? RECALL_RESULT_DISPLAY[result].label : "Waiting";
}

function recallResultTone(evaluation: V2ReviewAnswer["evaluation"]): string {
  if (
    evaluation.status === "failed" ||
    evaluation.recallResult === "incorrect"
  ) {
    return "low";
  }
  if (evaluation.recallResult === "partial") return "medium";
  if (evaluation.recallResult === "correct") {
    return "high";
  }
  return "neutral";
}

function scheduledDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
    : null;
}

function submittedDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "Saved answer";
}

function FeedbackRow({
  turn,
  onCorrectRecallResult,
  onRetryEvaluation,
}: {
  turn: V2ReviewAnswer;
  onCorrectRecallResult: (
    submissionId: string,
    recallResult: V2RecallResult,
  ) => Promise<void>;
  onRetryEvaluation: (submissionId: string) => Promise<void>;
}) {
  const evaluation = turn.evaluation;
  const isPending = evaluation.status === "pending";
  const [open, setOpen] = useState(false);
  const previousEvaluationStatus = useRef(evaluation.status);
  const [savingRecallResult, setSavingRecallResult] =
    useState<V2RecallResult | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [copyStatus, setCopyStatus] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const recallResult = recallResultLabel(evaluation.recallResult);
  const resultSymbol = evaluation.recallResult
    ? RECALL_RESULT_DISPLAY[evaluation.recallResult].symbol
    : "?";
  const dueDateLabel = scheduledDate(evaluation.nextDueOn);
  const dueIntervalLabel = reviewIntervalLabel(evaluation.nextDueOn);

  useEffect(() => {
    if (
      previousEvaluationStatus.current === "pending" &&
      evaluation.status !== "pending"
    ) {
      setOpen(true);
    }
    previousEvaluationStatus.current = evaluation.status;
  }, [evaluation.status]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timeout = window.setTimeout(() => setCopyStatus("idle"), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  async function correctRecallResult(nextResult: V2RecallResult) {
    setSavingRecallResult(nextResult);
    try {
      await onCorrectRecallResult(evaluation.submissionId, nextResult);
    } finally {
      setSavingRecallResult(null);
    }
  }

  async function retryEvaluation() {
    setRetrying(true);
    try {
      await onRetryEvaluation(evaluation.submissionId);
    } finally {
      setRetrying(false);
    }
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(reviewHandoffMarkdown(turn));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <li
      className={`previous-row ${isPending ? "previous-row-pending" : "previous-row-resolved"} ${open ? "previous-row-open" : "previous-row-collapsed"}`}
    >
      <div className="previous-score-slot">
        {isPending ? (
          <span className="pending-spinner" aria-label="Evaluation pending" />
        ) : (
          <span
            aria-label={
              evaluation.recallResult
                ? `Recall Result: ${recallResult}`
                : evaluation.status === "failed"
                  ? "Evaluation failed"
                  : "Recall Result waiting"
            }
            className="previous-score-shell"
          >
            <span
              className={`previous-score score-${recallResultTone(evaluation)}`}
            >
              {resultSymbol}
            </span>
          </span>
        )}
      </div>

      <div className="previous-row-main-button previous-row-main-static">
        <div className="previous-copy">
          <div className="previous-field previous-question-field">
            <span className="previous-label-row">
              <span className="previous-field-label">Question</span>
              <span className="review-grade-label">
                {isPending
                  ? "Evaluating…"
                  : evaluation.status === "failed"
                    ? "Evaluation failed"
                    : recallResult}
              </span>
            </span>
            <MarkdownInline
              as="p"
              className="previous-question"
              enableMath
              text={turn.prompt}
            />
            {isPending ? (
              <p className="previous-question-feedback previous-question-feedback-pending">
                Checking your recall…
              </p>
            ) : evaluation.feedback ? (
              <MarkdownContent
                className="previous-question-feedback"
                enableMath
                text={evaluation.feedback}
              />
            ) : null}
          </div>

          <div className="previous-detail-grid" hidden={!open}>
            <div className="review-handoff-actions">
              <button
                aria-label="Copy review as Markdown"
                className="review-handoff-copy"
                onClick={copyMarkdown}
                type="button"
              >
                {copyStatus === "copied" ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </button>
              <span aria-live="polite" className="sr-only">
                {copyStatus === "copied"
                  ? "Review copied to clipboard as Markdown."
                  : copyStatus === "failed"
                    ? "Review could not be copied."
                    : ""}
              </span>
            </div>
            <div className="previous-field">
              <span className="previous-field-label">Your answer</span>
              <p className="previous-answer">{turn.answer}</p>
            </div>
            {!isPending ? (
              <>
                <div className="previous-field">
                  <span className="previous-field-label">Answer Standard</span>
                  <MarkdownContent
                    className="previous-answer"
                    enableMath
                    text={evaluation.expectedAnswer ?? "Unavailable"}
                  />
                </div>
              </>
            ) : null}
            {evaluation.coveredPoints.length > 0 ? (
              <div className="previous-field review-feedback-points is-covered">
                <span className="previous-field-label">Recovered</span>
                <ul>
                  {evaluation.coveredPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evaluation.scoringIssues.length > 0 ? (
              <div className="previous-field review-feedback-points is-missing">
                <span className="previous-field-label">Scoring issues</span>
                <ul>
                  {evaluation.scoringIssues.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evaluation.clarifications.length > 0 ? (
              <div className="previous-field review-feedback-points">
                <span className="previous-field-label">Clarifications</span>
                <ul>
                  {evaluation.clarifications.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evaluation.canRetryEvaluation ? (
              <button
                className="review-correction-trigger"
                disabled={retrying}
                onClick={retryEvaluation}
                type="button"
              >
                {retrying ? <LoaderCircle className="v2-spin" /> : null}
                Retry evaluation
              </button>
            ) : null}
            {evaluation.canCorrectRecallResult ? (
              <fieldset className="review-grade-correction">
                <legend>Correct Recall Result</legend>
                <div>
                  {(["incorrect", "partial", "correct"] as V2RecallResult[]).map(
                    (nextResult) => (
                      <button
                        aria-pressed={evaluation.recallResult === nextResult}
                        disabled={
                          Boolean(savingRecallResult) ||
                          evaluation.recallResult === nextResult
                        }
                        key={nextResult}
                        onClick={() => correctRecallResult(nextResult)}
                        type="button"
                      >
                        {savingRecallResult === nextResult ? (
                          <LoaderCircle className="v2-spin" />
                        ) : (
                          recallResultLabel(nextResult)
                        )}
                      </button>
                    ),
                  )}
                </div>
              </fieldset>
            ) : null}
          </div>
        </div>

        <span className="previous-row-meta">
          <span className="previous-time-control">
            <time className="previous-time" dateTime={turn.submittedAt}>
              {submittedDate(turn.submittedAt)}
            </time>
            <button
              aria-expanded={open}
              aria-label={open ? "Hide answer details" : "Show answer details"}
              className="review-feedback-toggle"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <ChevronDown className="previous-collapse-icon" aria-hidden="true" />
            </button>
          </span>
          {dueDateLabel && dueIntervalLabel && evaluation.nextDueOn ? (
            <time
              aria-label={`Next review on ${dueDateLabel}`}
              className="previous-schedule-label"
              dateTime={evaluation.nextDueOn}
            >
              {dueIntervalLabel}
            </time>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function TimezoneSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<V2LearnerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timezones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];

  useEffect(() => {
    jsonRequest<V2LearnerSettings>("/api/v2/settings")
      .then(setSettings)
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : "Could not load settings.",
        ),
      );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await jsonRequest<V2LearnerSettings>("/api/v2/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: String(form.get("timezone") ?? "") }),
      });
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    }
  }

  return (
    <div className="v2-dialog-backdrop" onMouseDown={onClose}>
      <div
        aria-labelledby="timezone-settings-title"
        aria-modal="true"
        className="v2-dialog v2-settings-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="v2-dialog-heading">
          <div>
            <span className="v2-kicker">Local Day</span>
            <h2 id="timezone-settings-title">Timezone</h2>
          </div>
          <button
            aria-label="Close timezone settings"
            className="v2-icon-button"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {settings ? (
          <form className="v2-form" onSubmit={submit}>
            <label>
              IANA timezone
              <input
                autoComplete="off"
                defaultValue={settings.timezone ?? "UTC"}
                list="iana-timezones"
                name="timezone"
                required
                type="text"
              />
            </label>
            <datalist id="iana-timezones">
              <option value="UTC" />
              {timezones.map((timezone) => (
                <option key={timezone} value={timezone} />
              ))}
            </datalist>
            {error ? <p className="v2-error" role="alert">{error}</p> : null}
            <div className="v2-dialog-actions">
              <button
                className="v2-button-secondary"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button className="v2-button-primary" type="submit">
                Save timezone
              </button>
            </div>
          </form>
        ) : (
          <LoaderCircle className="v2-spin v2-dialog-loader" />
        )}
      </div>
    </div>
  );
}

export default function ReviewApp() {
  const { setDueCount } = useToolbarState();
  const [review, setReview] = useState<V2ReviewQueueResponse | null>(null);
  const [answer, setAnswer] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flagQuestion, setFlagQuestion] = useState<V2ReviewQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement | null>(null);
  const restingRef = useRef<HTMLDivElement | null>(null);
  const selectedQuestionIdRef = useRef<string | null>(null);

  const loadQueue = useCallback(async (selection: {
    questionId?: string | null;
    afterQuestionId?: string | null;
  } = {}) => {
    const params = new URLSearchParams();
    if (selection.questionId) params.set("questionId", selection.questionId);
    if (selection.afterQuestionId) {
      params.set("afterQuestionId", selection.afterQuestionId);
    }
    const query = params.toString();
    const next = await jsonRequest<V2ReviewQueueResponse>(
      `/api/v2/review/queue${query ? `?${query}` : ""}`,
    );
    selectedQuestionIdRef.current = next.question?.questionId ?? null;
    setReview(next);
    setDueCount(next.summary.queueRemaining);
    return next;
  }, [setDueCount]);

  useEffect(() => {
    async function initializeReview() {
      const settings = await jsonRequest<V2LearnerSettings>("/api/v2/settings");
      if (!settings.timezone) {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await jsonRequest<V2LearnerSettings>("/api/v2/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone: detected }),
        });
      }
      await loadQueue({ questionId: selectedQuestionIdRef.current });
    }

    initializeReview()
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : "Could not load Review.",
        ),
      )
      .finally(() => setIsLoading(false));
  }, [loadQueue]);

  useEffect(() => {
    answerRef.current?.focus();
  }, [review?.question?.questionId]);

  useEffect(() => {
    if (!review?.recentAnswers.some(
      (turn) => turn.evaluation.status === "pending",
    )) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        await loadQueue({ questionId: selectedQuestionIdRef.current });
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not refresh feedback.",
          );
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 900);
      }
    };
    timer = window.setTimeout(poll, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadQueue, review?.recentAnswers]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const question = review?.question;
    const responseText = answer.trim();
    if (!question || !responseText || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setAnswer("");
    try {
      await jsonRequest(
        "/api/v2/review/answer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionId: question.questionId,
            answer: responseText,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      selectedQuestionIdRef.current = null;
      await loadQueue();
    } catch (caught) {
      setAnswer(responseText);
      setError(caught instanceof Error ? caught.message : "Could not submit.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function nextQuestion() {
    const current = review?.question;
    if (
      !current ||
      review.summary.queueRemaining <= 1 ||
      isSubmitting ||
      isAdvancing
    ) return;
    const draft = answer;
    setIsAdvancing(true);
    setError(null);
    setAnswer("");
    try {
      await loadQueue({ afterQuestionId: current.questionId });
    } catch (caught) {
      setAnswer(draft);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load the next Question.",
      );
    } finally {
      setIsAdvancing(false);
    }
  }

  async function correctRecallResult(
    submissionId: string,
    recallResult: V2RecallResult,
  ) {
    await jsonRequest(
      "/api/v2/review/evaluation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, recallResult }),
      },
    );
    await loadQueue();
  }

  async function retryEvaluation(submissionId: string) {
    await jsonRequest(
      "/api/v2/review/evaluation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, action: "retry" }),
      },
    );
    await loadQueue();
  }

  const question: V2ReviewQuestion | null = review?.question ?? null;
  const isResting = !isLoading && !question;
  const nextScheduled = scheduledDate(review?.summary.nextScheduledOn ?? null);

  return (
    <main className="page">
      <section className="review-shell" aria-label="Recall practice">
        <ReviewToolbar />
        <div
          aria-labelledby="review-tab"
          className={`review-stage${isResting ? " review-stage-resting" : ""}`}
          id="review-panel"
          role="tabpanel"
        >
          <section className="question-area">
            {isLoading ? (
              <div className="question-copy">
                <h2 className="question-title">Loading next question...</h2>
              </div>
            ) : question ? (
              <div className="question-copy">
                <div className="review-question-heading">
                  <MarkdownInline
                    as="h2"
                    className="question-title"
                    enableMath
                    text={question.prompt}
                  />
                  <div className="review-question-actions">
                    <button
                      aria-label="Next question"
                      className="review-next-trigger"
                      disabled={
                        question.total <= 1 ||
                        isSubmitting ||
                        isAdvancing
                      }
                      onClick={nextQuestion}
                      title="Next question"
                      type="button"
                    >
                      <span>Next</span>
                      <ArrowRight aria-hidden="true" />
                    </button>
                    <button
                      aria-label="Flag current Question"
                      className="review-flag-trigger"
                      disabled={isAdvancing}
                      onClick={() => setFlagQuestion(question)}
                      type="button"
                    >
                      <Flag aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="resting-state" ref={restingRef} tabIndex={-1}>
                <p className="resting-kicker">
                  {review?.waitingOnEvaluation
                    ? "Evaluation in progress"
                    : "Review Queue"}
                </p>
                <h2 className="resting-title">
                  {review?.waitingOnEvaluation
                    ? "Finishing your feedback."
                    : "Your queue is clear."}
                </h2>
                <p className="resting-copy">
                  {review?.waitingOnEvaluation
                    ? "Your answer is saved while the evaluator finishes."
                    : nextScheduled
                      ? `The next scheduled Review is ${nextScheduled}.`
                      : "Add an Active Question to your Library whenever you learn something worth keeping."}
                </p>
              </div>
            )}
          </section>

          {isLoading ? (
            <div className="composer composer-loading" aria-hidden="true">
              <div className="composer-row composer-loading-row">
                <div className="composer-loading-input" />
                <div className="composer-loading-button" />
                <div className="composer-loading-button composer-loading-button-accent" />
              </div>
            </div>
          ) : question ? (
            <AnswerComposer
              ariaLabel="Your answer"
              autoFocus
              disabled={isSubmitting || isAdvancing}
              id="review-answer"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onSubmit={submit}
              onValueChange={setAnswer}
              placeholder="Type your answer here..."
              rows={4}
              submitAriaLabel="Submit answer"
              submitDisabled={!answer.trim() || isSubmitting || isAdvancing}
              submitIcon={
                isSubmitting ? <LoaderCircle className="v2-spin" /> : undefined
              }
              textareaRef={answerRef}
              value={answer}
            />
          ) : null}

          {error ? (
            <p className="error-message" role="alert">{error}</p>
          ) : null}

          <section className="previous-panel" aria-label="Answer feedback">
            <div className="previous-header">
              <h2>Previous answers</h2>
              {!isLoading ? (
                <button
                  aria-label="Local Day settings"
                  className="review-settings-button"
                  onClick={() => setSettingsOpen(true)}
                  type="button"
                >
                  <Settings2 aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <ol className="previous-list">
              {isLoading ? (
                Array.from({ length: 2 }).map((_, index) => (
                  <li
                    className="previous-row previous-row-placeholder"
                    key={`review-loading-placeholder-${index}`}
                  >
                    <div className="previous-placeholder-score" />
                    <div className="previous-placeholder-copy">
                      <span />
                      <span />
                    </div>
                  </li>
                ))
              ) : review && review.recentAnswers.length > 0 ? (
                review.recentAnswers.map((turn) => (
                  <FeedbackRow
                    key={turn.evaluation.submissionId}
                    onCorrectRecallResult={correctRecallResult}
                    onRetryEvaluation={retryEvaluation}
                    turn={turn}
                  />
                ))
              ) : (
                <li className="previous-row previous-row-empty">
                  <p>Your evaluated answers will appear here.</p>
                </li>
              )}
            </ol>
          </section>
        </div>
      </section>
      {settingsOpen ? (
        <TimezoneSettings
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await loadQueue();
          }}
        />
      ) : null}
      {flagQuestion ? (
        <ReviewFlagDialog
          onClose={() => setFlagQuestion(null)}
          onSubmitted={() => {
            (answerRef.current ?? restingRef.current)?.focus();
          }}
          onSubmit={async ({ reasons, detail }) => {
            const result = await jsonRequest<{
              review: V2ReviewQueueResponse;
            }>("/api/v2/review/flag", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                questionId: flagQuestion.questionId,
                reasons,
                detail,
              }),
            });
            setReview(result.review);
            selectedQuestionIdRef.current =
              result.review.question?.questionId ?? null;
            setDueCount(result.review.summary.queueRemaining);
          }}
        />
      ) : null}
    </main>
  );
}
