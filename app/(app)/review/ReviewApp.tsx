"use client";

import { ChevronDown, LoaderCircle, Settings2 } from "lucide-react";
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
import type {
  V2Grade,
  V2LearnerSettings,
  V2ReviewAnswer,
  V2ReviewQuestion,
  V2ReviewQueueResponse,
} from "@/app/lib/v2/types";

const GRADE_DISPLAY: Record<V2Grade, { label: string; value: number }> = {
  again: { label: "Again", value: 0 },
  hard: { label: "Hard", value: 2 },
  good: { label: "Good", value: 3 },
  easy: { label: "Easy", value: 4 },
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Waxon could not complete that action.");
  }
  return body as T;
}

function gradeLabel(grade: V2Grade | null): string {
  return grade ? GRADE_DISPLAY[grade].label : "Waiting";
}

function gradeTone(evaluation: V2ReviewAnswer["evaluation"]): string {
  if (evaluation.status === "failed" || evaluation.grade === "again") {
    return "low";
  }
  if (evaluation.grade === "hard") return "medium";
  if (evaluation.grade === "good" || evaluation.grade === "easy") {
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
  onSelfGrade,
}: {
  turn: V2ReviewAnswer;
  onSelfGrade: (submissionId: string, grade: V2Grade) => Promise<void>;
}) {
  const evaluation = turn.evaluation;
  const isPending = evaluation.status === "pending";
  const [open, setOpen] = useState(!isPending);
  const [savingGrade, setSavingGrade] = useState<V2Grade | null>(null);
  const grade = gradeLabel(evaluation.grade);
  const scoreLabel =
    evaluation.status === "failed" || !evaluation.grade
      ? "?"
      : GRADE_DISPLAY[evaluation.grade].value;
  const dueLabel = scheduledDate(evaluation.nextDueOn);

  useEffect(() => {
    if (evaluation.status !== "pending") setOpen(true);
  }, [evaluation.status]);

  async function selfGrade(nextGrade: V2Grade) {
    setSavingGrade(nextGrade);
    try {
      await onSelfGrade(evaluation.submissionId, nextGrade);
    } finally {
      setSavingGrade(null);
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
              evaluation.grade
                ? `Grade ${grade} (${GRADE_DISPLAY[evaluation.grade].value})`
                : `Grade ${grade}`
            }
            className="previous-score-shell"
          >
            <span className={`previous-score score-${gradeTone(evaluation)}`}>
              {scoreLabel}
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
                    ? "Self-grade needed"
                    : grade}
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
                <div className="previous-field">
                  <span className="previous-field-label">Demonstrated Gap</span>
                  <MarkdownContent
                    className="previous-answer"
                    enableMath
                    text={evaluation.demonstratedGap ?? "Unavailable"}
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
            {evaluation.missingPoints.length > 0 ? (
              <div className="previous-field review-feedback-points is-missing">
                <span className="previous-field-label">Missing</span>
                <ul>
                  {evaluation.missingPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evaluation.canSelfGrade ? (
              <fieldset className="review-grade-correction">
                <legend>How well did you recall it?</legend>
                <div>
                  {(["again", "hard", "good", "easy"] as V2Grade[]).map(
                    (nextGrade) => (
                      <button
                        disabled={Boolean(savingGrade)}
                        key={nextGrade}
                        onClick={() => selfGrade(nextGrade)}
                        type="button"
                      >
                        {savingGrade === nextGrade ? (
                          <LoaderCircle className="v2-spin" />
                        ) : (
                          `${gradeLabel(nextGrade)} (${GRADE_DISPLAY[nextGrade].value})`
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
          {dueLabel && evaluation.nextDueOn ? (
            <time
              aria-label={`Next review scheduled for ${dueLabel}`}
              className="previous-schedule-label"
              dateTime={evaluation.nextDueOn}
            >
              Scheduled {dueLabel}
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
            ×
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
              <small>Review uses this timezone to determine your Local Day.</small>
            </label>
            <datalist id="iana-timezones">
              <option value="UTC" />
              {timezones.map((timezone) => (
                <option key={timezone} value={timezone} />
              ))}
            </datalist>
            {error ? <p className="v2-error" role="alert">{error}</p> : null}
            <div className="v2-dialog-actions">
              <button onClick={onClose} type="button">Cancel</button>
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement | null>(null);

  const loadQueue = useCallback(async () => {
    const next = await jsonRequest<V2ReviewQueueResponse>(
      "/api/v2/review/queue",
    );
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
      await loadQueue();
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
  }, [review?.question?.questionVersionId]);

  useEffect(() => {
    if (!review?.recentAnswers.some(
      (turn) => turn.evaluation.status === "pending",
    )) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        await loadQueue();
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
            questionVersionId: question.questionVersionId,
            answer: responseText,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      await loadQueue();
    } catch (caught) {
      setAnswer(responseText);
      setError(caught instanceof Error ? caught.message : "Could not submit.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function selfGrade(submissionId: string, grade: V2Grade) {
    await jsonRequest(
      "/api/v2/review/evaluation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, grade }),
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
                <MarkdownInline
                  as="h2"
                  className="question-title"
                  enableMath
                  text={question.prompt}
                />
              </div>
            ) : (
              <div className="resting-state">
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
                      : "Add an Active Question in Library whenever you learn something worth keeping."}
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
              disabled={isSubmitting}
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
              submitDisabled={!answer.trim() || isSubmitting}
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
                    onSelfGrade={selfGrade}
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
    </main>
  );
}
