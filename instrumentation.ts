import * as Sentry from "@sentry/nextjs";

export function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" ||
    process.env.NEXT_RUNTIME === "edge"
  ) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 1,
      enableLogs: true,
      sendDefaultPii: true,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
