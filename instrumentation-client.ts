import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://edadd0eec2d226fbf85747941c24a155@o4511061698478080.ingest.de.sentry.io/4511508028522576",

  integrations: [Sentry.replayIntegration()],

  tracesSampleRate: 1,
  enableLogs: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  sendDefaultPii: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
