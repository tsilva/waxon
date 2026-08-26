"use client";

import { Flag, LoaderCircle, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";
import {
  MAX_REVIEW_FLAG_DETAIL_LENGTH,
  REVIEW_FLAG_REASONS,
  type ReviewFlagReason,
} from "@/app/lib/v2/reviewFlag";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[href]:not([aria-disabled="true"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function ReviewFlagDialog({
  onClose,
  onSubmitted,
  onSubmit,
}: {
  onClose: () => void;
  onSubmitted: () => void;
  onSubmit: (input: {
    reasons: ReviewFlagReason[];
    detail: string;
  }) => Promise<void>;
}) {
  const [selectedReasons, setSelectedReasons] = useState<ReviewFlagReason[]>([]);
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstReasonRef = useRef<HTMLButtonElement | null>(null);
  const submittedRef = useRef(false);
  usePageScrollLock(true);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() => firstReasonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (
        !submittedRef.current &&
        previouslyFocused &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  function close() {
    if (!saving) onClose();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleReason(reason: ReviewFlagReason) {
    setSelectedReasons((current) =>
      current.includes(reason)
        ? current.filter((candidate) => candidate !== reason)
        : [...current, reason],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ reasons: selectedReasons, detail });
      submittedRef.current = true;
      onClose();
      window.requestAnimationFrame(onSubmitted);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not Flag this Question.",
      );
      setSaving(false);
    }
  }

  return (
    <div
      className="v2-dialog-backdrop review-flag-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || saving) return;
        onClose();
      }}
    >
      <div
        aria-describedby="review-flag-description"
        aria-labelledby="review-flag-title"
        aria-modal="true"
        className="v2-dialog review-flag-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="v2-dialog-heading">
          <div>
            <span className="v2-kicker">Review attention</span>
            <h2 id="review-flag-title">Flag this Question</h2>
          </div>
          <button
            aria-label="Close Flag dialog"
            className="v2-icon-button"
            disabled={saving}
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="review-flag-description" id="review-flag-description">
          Reasons are optional.
        </p>
        <form className="review-flag-form" onSubmit={submit}>
          <fieldset>
            <legend>What needs attention?</legend>
            <div className="review-flag-reasons">
              {REVIEW_FLAG_REASONS.map((reason, index) => (
                <button
                  aria-pressed={selectedReasons.includes(reason.id)}
                  disabled={saving}
                  key={reason.id}
                  onClick={() => toggleReason(reason.id)}
                  ref={index === 0 ? firstReasonRef : undefined}
                  type="button"
                >
                  <Flag aria-hidden="true" />
                  {reason.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="review-flag-detail">
            Optional detail
            <textarea
              disabled={saving}
              maxLength={MAX_REVIEW_FLAG_DETAIL_LENGTH}
              name="detail"
              onChange={(event) => setDetail(event.currentTarget.value)}
              placeholder="Add anything that will help you resolve it later."
              rows={4}
              value={detail}
            />
          </label>
          {error ? (
            <p className="v2-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="v2-dialog-actions">
            <button disabled={saving} onClick={close} type="button">
              Cancel
            </button>
            <button
              className="v2-button-primary"
              disabled={saving}
              type="submit"
            >
              {saving ? <LoaderCircle className="v2-spin" /> : <Flag />}
              Flag Question
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
