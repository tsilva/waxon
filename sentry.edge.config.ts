import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://edadd0eec2d226fbf85747941c24a155@o4511061698478080.ingest.de.sentry.io/4511508028522576",

  tracesSampleRate: 1,
  enableLogs: true,
  sendDefaultPii: true,
});
