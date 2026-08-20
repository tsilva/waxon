"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  LoaderCircle,
  Settings2,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MarkdownContent } from "@/app/MarkdownContent";
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

function FeedbackCard({
  turn,
  onCorrect,
}: {
  turn: ReviewTurn;
  onCorrect: (submissionId: string, grade: V2Grade) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [savingGrade, setSavingGrade] = useState<V2Grade | null>(null);
  const evaluation = turn.evaluation;

  async function correct(grade: V2Grade) {
    setSavingGrade(grade);
    try {
      await onCorrect(evaluation.submissionId, grade);
    } finally {
      setSavingGrade(null);
    }
  }

  return (
    <article className={`v2-feedback-card is-${evaluation.status}`}>
      <button
        aria-expanded={open}
        className="v2-feedback-summary"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {evaluation.status === "pending" ? (
          <LoaderCircle className="v2-spin" />
        ) : evaluation.grade === "again" || evaluation.status === "failed" ? (
          <AlertTriangle />
        ) : (
          <Check />
        )}
        <span>
          <strong>
            {evaluation.status === "pending"
              ? "Checking your recall…"
              : evaluation.status === "failed"
                ? "Self-grade this answer"
                : gradeLabel(evaluation.grade)}
          </strong>
          <small>{turn.prompt}</small>
        </span>
        <ChevronDown />
      </button>
      {open ? (
        <div className="v2-feedback-body">
          <div>
            <span>Your answer</span>
            <p>{turn.answer}</p>
          </div>
          {evaluation.feedback ? (
            <div>
              <span>Feedback</span>
              <MarkdownContent
                className="v2-markdown"
                enableMath
                text={evaluation.feedback}
              />
            </div>
          ) : null}
          {evaluation.expectedAnswer ? (
            <div>
              <span>Expected answer</span>
              <MarkdownContent
                className="v2-markdown"
                enableMath
                text={evaluation.expectedAnswer}
              />
            </div>
          ) : null}
          {evaluation.coveredPoints.length > 0 ? (
            <div className="v2-points is-covered">
              <span>Recovered</span>
              <ul>
                {evaluation.coveredPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          {evaluation.missingPoints.length > 0 ? (
            <div className="v2-points is-missing">
              <span>Missing</span>
              <ul>
                {evaluation.missingPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          {evaluation.status !== "pending" ? (
            <fieldset className="v2-grade-correction">
              <legend>
                {evaluation.grade ? "Correct the grade" : "How well did you recall it?"}
              </legend>
              <div>
                {(["again", "hard", "good", "easy"] as V2Grade[]).map((grade) => (
                  <button
                    aria-pressed={evaluation.grade === grade}
                    disabled={Boolean(savingGrade)}
                    key={grade}
                    onClick={() => correct(grade)}
                    type="button"
                  >
                    {savingGrade === grade ? <LoaderCircle className="v2-spin" /> : gradeLabel(grade)}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </article>
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
    if (!item || !responseText || isSubmitting) {
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
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <main className="page">
      <section className="review-shell v2-review-shell">
        <ReviewToolbar />
        <div className="v2-review-stage" id="review-panel">
          <header className="v2-review-context">
            <div>
              <span className="v2-kicker">Today’s minimum effective practice</span>
              <strong>
                {review?.session
                  ? `${Math.max(0, total - completed)} remaining`
                  : "Review complete"}
              </strong>
            </div>
            <div className="v2-review-progress" aria-label={`${percent}% complete`}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <button
              aria-label="Review settings"
              className="v2-icon-button"
              onClick={() => setSettingsOpen(true)}
              type="button"
            >
              <Settings2 />
            </button>
          </header>
          {review && !review.capacity.targetFeasible ? (
            <div className="v2-capacity-warning">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>Your current retention target exceeds today’s capacity.</strong>
                <span>
                  At {review.capacity.atRiskCount} at-risk questions, the
                  sustainable estimate is{" "}
                  {Math.round(review.capacity.sustainableRetention * 100)}%.
                  Waxon is prioritizing the most fragile memories first. About{" "}
                  {review.capacity.minutesNeeded} minutes would protect all
                  currently at-risk work.
                </span>
              </div>
              <button onClick={() => setSettingsOpen(true)} type="button">
                Adjust plan
              </button>
            </div>
          ) : null}
          <div className="v2-review-column">
            {isLoading ? (
              <div className="v2-review-empty">
                <LoaderCircle className="v2-spin" />
                <h1>Building today’s plan…</h1>
              </div>
            ) : item ? (
              <section className="v2-recall-card">
                <div className="v2-question-meta">
                  <span>
                    {item.isRetry
                      ? "Delayed retry"
                      : `Question ${item.position + 1}`}
                  </span>
                  <span><Clock3 /> about {item.estimatedMinutes} min</span>
                </div>
                <h1>
                  <MarkdownContent
                    className="v2-markdown"
                    enableMath
                    text={item.prompt}
                  />
                </h1>
                <form className="v2-answer-form" onSubmit={submit}>
                  <label htmlFor="v2-answer">Answer from memory, in your own words</label>
                  <textarea
                    id="v2-answer"
                    maxLength={65_536}
                    onChange={(event) => setAnswer(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Retrieve first. Explain enough to prove you know it…"
                    ref={answerRef}
                    rows={7}
                    value={answer}
                  />
                  <div>
                    <small>⌘ Enter to submit</small>
                    <button
                      className="v2-button-primary"
                      disabled={!answer.trim() || isSubmitting}
                      type="submit"
                    >
                      {isSubmitting ? <LoaderCircle className="v2-spin" /> : <ArrowRight />}
                      Submit and continue
                    </button>
                  </div>
                </form>
              </section>
            ) : (
              <div className="v2-review-empty">
                {review?.retryAvailableAt &&
                new Date(review.retryAvailableAt).getTime() > Date.now() ? (
                  <>
                    <Clock3 />
                    <h1>Your retry is deliberately delayed.</h1>
                    <p>
                      It unlocks at{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(review.retryAvailableAt))}
                      . This prevents immediate repetition from masquerading as
                      durable recall.
                    </p>
                  </>
                ) : review?.waitingOnEvaluation || turns.some((turn) => turn.evaluation.status === "pending") ? (
                  <>
                    <LoaderCircle className="v2-spin" />
                    <h1>Finishing your feedback</h1>
                    <p>Your answers are safe. The session will close as grading finishes.</p>
                  </>
                ) : (
                  <>
                    <Sparkles />
                    <h1>You protected what mattered today.</h1>
                    <p>
                      {review?.summary.nextScheduledDue
                        ? `The next scheduled review is ${new Intl.DateTimeFormat(
                            undefined,
                            { dateStyle: "medium", timeStyle: "short" },
                          ).format(review.summary.nextScheduledDue)}.`
                        : "Add knowledge in Library whenever you learn something worth keeping."}
                    </p>
                  </>
                )}
              </div>
            )}
            {error ? <p className="v2-error" role="alert">{error}</p> : null}
            {turns.length > 0 ? (
              <section className="v2-feedback-list" aria-label="Answer feedback">
                <h2>Session feedback</h2>
                {turns.map((turn) => (
                  <FeedbackCard
                    key={turn.evaluation.submissionId}
                    onCorrect={correctGrade}
                    turn={turn}
                  />
                ))}
              </section>
            ) : null}
          </div>
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
