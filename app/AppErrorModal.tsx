"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type AppErrorInput = {
  title?: string;
  message: string;
  details?: string | null;
};

type AppErrorState = Required<Pick<AppErrorInput, "title" | "message">> & {
  details: string | null;
};

type AppErrorContextValue = {
  showError: (error: AppErrorInput) => void;
  clearError: () => void;
};

const AppErrorContext = createContext<AppErrorContextValue | null>(null);

function errorDetails(error: unknown): string | null {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error === null || error === undefined) {
    return null;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function normalizeError(input: AppErrorInput): AppErrorState {
  return {
    title: input.title?.trim() || "Something went wrong",
    message: input.message.trim() || "An unexpected error occurred.",
    details: input.details?.trim() || null,
  };
}

export function AppErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<AppErrorState | null>(null);

  const clearError = useCallback(() => setError(null), []);
  const showError = useCallback((input: AppErrorInput) => {
    setError(normalizeError(input));
  }, []);

  useEffect(() => {
    function handleWindowError(event: ErrorEvent) {
      showError({
        message: event.message || "An unexpected browser error occurred.",
        details: errorDetails(event.error),
      });
    }

    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "An unexpected async error occurred.";

      showError({
        message,
        details: errorDetails(reason),
      });
    }

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [showError]);

  useEffect(() => {
    if (!error) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        clearError();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearError, error]);

  const contextValue = useMemo(
    () => ({ showError, clearError }),
    [clearError, showError],
  );

  return (
    <AppErrorContext.Provider value={contextValue}>
      {children}
      {error ? (
        <div
          className="app-error-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              clearError();
            }
          }}
        >
          <section
            className="app-error-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-error-modal-title"
            aria-describedby="app-error-modal-message"
          >
            <div className="app-error-modal-header">
              <div>
                <p className="app-error-modal-kicker">Error</p>
                <h2 className="app-error-modal-title" id="app-error-modal-title">
                  {error.title}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close error details"
                onClick={clearError}
              />
            </div>

            <p className="app-error-modal-message" id="app-error-modal-message">
              {error.message}
            </p>

            {error.details ? (
              <details className="app-error-modal-details" open>
                <summary>Details</summary>
                <pre>{error.details}</pre>
              </details>
            ) : null}
          </section>
        </div>
      ) : null}
    </AppErrorContext.Provider>
  );
}

export function useAppError() {
  const context = useContext(AppErrorContext);

  if (!context) {
    throw new Error("useAppError must be used inside AppErrorProvider.");
  }

  return context;
}
