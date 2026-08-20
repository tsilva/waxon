"use client";

import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Flag,
  LoaderCircle,
  Settings2,
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
import type {
  V2Evaluation,
  V2Grade,
  V2ReviewItem,
  V2ReviewSessionResponse,
} from "@/app/lib/v2/types";

type ReviewTurn = {
  prompt: string;
  answer: string;
  evaluation: V2Evaluation;
};

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(body.error || "Waxon could not complete that action.");
  }
  return body as T;
}

function gradeLabel(grade: V2Grade | null): string {
  return grade ? grade[0].toUpperCase() + grade.slice(1) : "Waiting";
}

function gradeTone(evaluation: V2Evaluation): string {
  if (evaluation.status === "failed" || evaluation.grade === "again") {
    return "low";
  }

  if (evaluation.grade === "hard") {
    return "medium";
  }

  if (evaluation.grade === "good" || evaluation.grade === "easy") {
    return "high";
  }

  return "neutral";
}

function FeedbackRow({
  turn,
  onCorrect,
}: {
  turn: ReviewTurn;
  onCorrect: (submissionId: string, grade: V2Grade) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [savingGrade, setSavingGrade] = useState<V2Grade | null>(null);
  const evaluation = turn.evaluation;
  const isPending = evaluation.status === "pending";
  const grade = gradeLabel(evaluation.grade);
  const scoreLabel = evaluation.status === "failed" ? "?" : grade.slice(0, 1);

  async function correct(grade: V2Grade) {
    setSavingGrade(grade);
    try {
      await onCorrect(evaluation.submissionId, grade);
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
          <span className="previous-score-shell" aria-label={`Grade ${grade}`}>
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
            ) : (
              <p className="previous-question-feedback">
                Choose the grade that best matches your recall.
              </p>
            )}
          </div>

          <div className="previous-detail-grid" hidden={!open}>
            <div className="previous-field">
              <span className="previous-field-label">Your answer</span>
              <p className="previous-answer">{turn.answer}</p>
            </div>
            {evaluation.expectedAnswer ? (
              <div className="previous-field">
                <span className="previous-field-label">Expected answer</span>
                <MarkdownContent
                  className="previous-answer"
                  enableMath
                  text={evaluation.expectedAnswer}
                />
              </div>
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
            {!isPending ? (
              <fieldset className="review-grade-correction">
                <legend>
                  {evaluation.grade
                    ? "Correct the grade"
                    : "How well did you recall it?"}
                </legend>
                <div>
                  {(["again", "hard", "good", "easy"] as V2Grade[]).map(
                    (nextGrade) => (
                      <button
                        aria-pressed={evaluation.grade === nextGrade}
                        disabled={Boolean(savingGrade)}
                        key={nextGrade}
                        onClick={() => correct(nextGrade)}
                        type="button"
                      >
                        {savingGrade === nextGrade ? (
                          <LoaderCircle className="v2-spin" />
                        ) : (
                          gradeLabel(nextGrade)
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
            <span className="previous-time">Just now</span>
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
        </span>
      </div>
    </li>
  );
}

function ReviewSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<{
    dailyMinutes: number;
    desiredRetention: number;
    newItemsPerDay: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jsonRequest<{
      dailyMinutes: number;
      desiredRetention: number;
      newItemsPerDay: number;
    }>("/api/v2/settings")
      .then(setSettings)
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not load settings."),
      );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await jsonRequest("/api/v2/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyMinutes: Number(form.get("dailyMinutes")),
          desiredRetention: Number(form.get("desiredRetention")) / 100,
          newItemsPerDay: Number(form.get("newItemsPerDay")),
        }),
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
        aria-labelledby="review-settings-title"
        aria-modal="true"
        className="v2-dialog v2-settings-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="v2-dialog-heading">
          <div>
            <span className="v2-kicker">Daily plan</span>
            <h2 id="review-settings-title">Capacity and retention</h2>
          </div>
          <button className="v2-icon-button" onClick={onClose} type="button">×</button>
        </div>
        {settings ? (
          <form className="v2-form" onSubmit={submit}>
            <label>
              Minutes available each day
              <input
                defaultValue={settings.dailyMinutes}
                max={120}
                min={1}
                name="dailyMinutes"
                type="number"
              />
            </label>
            <label>
              Target retention
              <input
                defaultValue={Math.round(settings.desiredRetention * 100)}
                max={97}
                min={70}
                name="desiredRetention"
                type="number"
              />
              <small>Percent, between 70 and 97.</small>
            </label>
            <label>
              Maximum new questions per day
              <input
                defaultValue={settings.newItemsPerDay}
                max={100}
                min={0}
                name="newItemsPerDay"
                type="number"
              />
            </label>
            {error ? <p className="v2-error">{error}</p> : null}
            <div className="v2-dialog-actions">
              <button onClick={onClose} type="button">Cancel</button>
              <button className="v2-button-primary" type="submit">Save plan</button>
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
  const [review, setReview] = useState<V2ReviewSessionResponse | null>(null);
  const [answer, setAnswer] = useState("");
  const [turns, setTurns] = useState<ReviewTurn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewAction, setReviewAction] = useState<"flag" | "next" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement | null>(null);

  const loadSession = useCallback(async () => {
    const next = await jsonRequest<V2ReviewSessionResponse>(
      "/api/v2/review/session",
    );
    setReview(next);
    return next;
  }, []);

  useEffect(() => {
    loadSession()
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not load Review."),
      )
      .finally(() => setIsLoading(false));
  }, [loadSession]);

  useEffect(() => {
    answerRef.current?.focus();
  }, [review?.item?.itemId]);

  useEffect(() => {
    if (!review?.retryAvailableAt) {
      return;
    }
    const wait = Math.max(
      250,
      Math.min(
        60_000,
        new Date(review.retryAvailableAt).getTime() - Date.now() + 150,
      ),
    );
    const timer = window.setTimeout(() => void loadSession(), wait);
    return () => window.clearTimeout(timer);
  }, [loadSession, review?.retryAvailableAt]);

  useEffect(() => {
    const pending = turns.filter(
      (turn) => turn.evaluation.status === "pending",
    );
    if (pending.length === 0) {
      return;
    }
    const timer = window.setInterval(async () => {
      const replacements = await Promise.all(
        pending.map(async (turn) => {
          try {
            const evaluation = await jsonRequest<V2Evaluation>(
              `/api/v2/review/evaluation?submissionId=${encodeURIComponent(
                turn.evaluation.submissionId,
              )}`,
            );
            return { submissionId: turn.evaluation.submissionId, evaluation };
          } catch {
            return null;
          }
        }),
      );
      const finished = replacements.some(
        (item) => item && item.evaluation.status !== "pending",
      );
      setTurns((current) =>
        current.map((turn) => {
          const replacement = replacements.find(
            (item) => item?.submissionId === turn.evaluation.submissionId,
          );
          return replacement
            ? { ...turn, evaluation: replacement.evaluation }
            : turn;
        }),
      );
      if (finished) {
        void loadSession();
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [loadSession, turns]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const item = review?.item;
    const responseText = answer.trim();
    if (!item || !responseText || isSubmitting || reviewAction) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setAnswer("");
    try {
      const evaluation = await jsonRequest<V2Evaluation>(
        "/api/v2/review/answer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: item.itemId, answer: responseText }),
        },
      );
      setTurns((current) => [
        { prompt: item.prompt, answer: responseText, evaluation },
        ...current,
      ]);
      await loadSession();
    } catch (caught) {
      setAnswer(responseText);
      setError(caught instanceof Error ? caught.message : "Could not submit.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function actOnQuestion(action: "flag" | "next") {
    const item = review?.item;
    if (!item || isSubmitting || reviewAction) return;
    setReviewAction(action);
    setError(null);
    try {
      const next = await jsonRequest<V2ReviewSessionResponse>(
        "/api/v2/review/session",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: item.itemId, action }),
        },
      );
      setAnswer("");
      setReview(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not move to the next question.",
      );
    } finally {
      setReviewAction(null);
    }
  }

  async function correctGrade(submissionId: string, grade: V2Grade) {
    const evaluation = await jsonRequest<V2Evaluation>(
      "/api/v2/review/evaluation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, grade }),
      },
    );
    setTurns((current) =>
      current.map((turn) =>
        turn.evaluation.submissionId === submissionId
          ? { ...turn, evaluation }
          : turn,
      ),
    );
    await loadSession();
  }

  const item: V2ReviewItem | null = review?.item ?? null;
  const completed = review?.session?.completedCount ?? 0;
  const total = review?.session?.plannedCount ?? 0;
  const isResting = !isLoading && !item;
  const retryAvailableAt = review?.retryAvailableAt
    ? new Date(review.retryAvailableAt)
    : null;
  const retryIsDelayed = Boolean(
    retryAvailableAt && retryAvailableAt.getTime() > Date.now(),
  );

  return (
    <main className="page">
      <section className="review-shell" aria-label="Flashcard learning">
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
                <div
                  aria-hidden="true"
                  className="review-question-actions review-question-actions-placeholder"
                >
                  <span />
                  <span />
                </div>
                <h2 className="question-title">Loading next question...</h2>
              </div>
            ) : item ? (
              <div className="question-copy">
                <div
                  aria-busy={Boolean(reviewAction)}
                  aria-label="Question actions"
                  className="review-question-actions"
                  role="group"
                >
                  <button
                    aria-label="Flag question for later"
                    className="question-flag-trigger"
                    disabled={isSubmitting || Boolean(reviewAction)}
                    onClick={() => void actOnQuestion("flag")}
                    title="Flag for later"
                    type="button"
                  >
                    {reviewAction === "flag" ? (
                      <LoaderCircle aria-hidden="true" className="v2-spin" />
                    ) : (
                      <Flag aria-hidden="true" />
                    )}
                  </button>
                  <button
                    aria-label="Next question"
                    className="question-next-trigger"
                    disabled={isSubmitting || Boolean(reviewAction)}
                    onClick={() => void actOnQuestion("next")}
                    title="Next question"
                    type="button"
                  >
                    {reviewAction === "next" ? (
                      <LoaderCircle aria-hidden="true" className="v2-spin" />
                    ) : (
                      <ArrowRight aria-hidden="true" />
                    )}
                  </button>
                </div>
                {item.isRetry ? (
                  <p className="review-question-kicker">Delayed retry</p>
                ) : null}
                <MarkdownInline
                  as="h2"
                  className="question-title"
                  enableMath
                  text={item.prompt}
                />
                {review && !review.capacity.targetFeasible ? (
                  <div className="review-capacity-warning">
                    <AlertTriangle aria-hidden="true" />
                    <p>
                      <strong>Today’s capacity is below your retention target.</strong>{" "}
                      Waxon is prioritizing the most fragile memories first.
                    </p>
                    <button onClick={() => setSettingsOpen(true)} type="button">
                      Adjust
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="resting-state">
                <p className="resting-kicker">
                  {retryIsDelayed
                    ? "Delayed retry"
                    : review?.waitingOnEvaluation ||
                        turns.some((turn) => turn.evaluation.status === "pending")
                      ? "Evaluation in progress"
                      : "Today’s review"}
                </p>
                <h2 className="resting-title">
                  {retryIsDelayed
                    ? "Let it settle."
                    : review?.waitingOnEvaluation ||
                        turns.some((turn) => turn.evaluation.status === "pending")
                      ? "Finishing your feedback."
                      : "You protected what mattered today."}
                </h2>
                <p className="resting-copy">
                  {retryIsDelayed && retryAvailableAt
                    ? `The retry unlocks at ${new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(retryAvailableAt)} so immediate repetition does not masquerade as durable recall.`
                    : review?.waitingOnEvaluation ||
                        turns.some((turn) => turn.evaluation.status === "pending")
                      ? "Your answers are safe. This session will close when grading finishes."
                      : review?.summary.nextScheduledDue
                        ? `The next scheduled review is ${new Intl.DateTimeFormat(
                            undefined,
                            { dateStyle: "medium", timeStyle: "short" },
                          ).format(review.summary.nextScheduledDue)}.`
                        : "Add knowledge in Library whenever you learn something worth keeping."}
                </p>
                {review?.session ? (
                  <dl className="resting-metrics">
                    <div>
                      <dt>{completed}</dt>
                      <dd>reviewed today</dd>
                    </div>
                    <div>
                      <dt>{Math.max(0, total - completed)}</dt>
                      <dd>remaining</dd>
                    </div>
                  </dl>
                ) : null}
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
          ) : item ? (
            <AnswerComposer
              ariaLabel="Your answer"
              autoFocus
              disabled={isSubmitting || Boolean(reviewAction)}
              id="review-answer"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onSubmit={submit}
              onValueChange={(value) => setAnswer(value)}
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
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}

          <section className="previous-panel" aria-label="Answer feedback">
            <div className="previous-header">
              <h2>Previous answers</h2>
              {!isLoading ? (
                <button
                  aria-label="Review settings"
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
              ) : turns.length > 0 ? (
                turns.map((turn) => (
                  <FeedbackRow
                    key={turn.evaluation.submissionId}
                    onCorrect={correctGrade}
                    turn={turn}
                  />
                ))
              ) : (
                <li className="previous-row previous-row-empty">
                  <p>Your answers from this session will appear here.</p>
                </li>
              )}
            </ol>
          </section>
        </div>
      </section>
      {settingsOpen ? (
        <ReviewSettings
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await loadSession();
          }}
        />
      ) : null}
    </main>
  );
}
