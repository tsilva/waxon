"use client";

import { ArrowUp } from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  Ref,
  useEffect,
  useId,
  useRef,
} from "react";

export function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }

  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  ref.current = value;
}

type AnswerComposerProps = {
  id: string;
  value: string;
  onValueChange: (
    value: string,
    textarea: HTMLTextAreaElement,
  ) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  submitDisabled?: boolean;
  submitAriaLabel?: string;
  submitTitle?: string;
  submitTooltipLabel?: string;
  submitIcon?: ReactNode;
  secondaryAction?: ReactNode;
  after?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export function AnswerComposer({
  id,
  value,
  onValueChange,
  onSubmit,
  placeholder,
  ariaLabel,
  className,
  textareaRef,
  rows = 4,
  autoFocus = false,
  disabled = false,
  submitDisabled = false,
  submitAriaLabel = "Submit answer",
  submitTitle,
  submitTooltipLabel,
  submitIcon,
  secondaryAction,
  after,
  onKeyDown,
}: AnswerComposerProps) {
  const tooltipId = useId();
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    resizeComposerTextarea(internalTextareaRef.current);
  }, [value, rows]);

  const resolvedClassName = className ? `composer ${className}` : "composer";
  const describedBy = submitTooltipLabel ? tooltipId : undefined;

  const submitButton = (
    <button
      className="composer-submit"
      type="submit"
      disabled={submitDisabled}
      aria-label={submitAriaLabel}
      aria-describedby={describedBy}
      title={submitTitle}
    >
      {submitIcon ?? <ArrowUp aria-hidden="true" />}
    </button>
  );

  return (
    <form className={resolvedClassName} onSubmit={onSubmit}>
      <div className="composer-row">
        <textarea
          id={id}
          ref={(node) => {
            internalTextareaRef.current = node;
            setRef(textareaRef, node);
          }}
          className="composer-input"
          value={value}
          onChange={(event) => {
            onValueChange(event.currentTarget.value, event.currentTarget);
            resizeComposerTextarea(event.currentTarget);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          rows={rows}
          autoFocus={autoFocus}
          disabled={disabled}
        />
        {secondaryAction}
        {submitTooltipLabel ? (
          <span className="icon-tooltip">
            <span className="icon-tooltip-bubble" id={tooltipId} role="tooltip">
              {submitTooltipLabel}
            </span>
            {submitButton}
          </span>
        ) : (
          submitButton
        )}
      </div>
      {after}
    </form>
  );
}
