import * as Sentry from "@sentry/nextjs";

const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,

    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0,
    ),
    beforeSendLog: process.env.NEXT_PUBLIC_SENTRY_ENABLE_LOGS === "1"
      ? undefined
      : () => null,
    replaysSessionSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_SAMPLE_RATE ?? 0,
    ),
    replaysOnErrorSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE ?? 0,
    ),
    dataCollection: process.env.NEXT_PUBLIC_SENTRY_SEND_DEFAULT_PII === "1"
      ? { frameContextLines: 7 }
      : {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          graphQL: { document: false, variables: false },
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          queues: false,
          frameContextLines: 7,
        },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
