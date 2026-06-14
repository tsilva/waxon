import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  htmlLimitedBots: /.*/,
  outputFileTracingIncludes: {
    "/api/questions/generate": ["./reference/question-quality.md"],
    "/api/submit-answer": ["./reference/question-quality.md"],
  },
};

export default withSentryConfig(nextConfig, {
  org: "tsilva",
  project: "waxon",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: true,
  },
  tunnelRoute: "/monitoring",

  webpack: {
    automaticVercelMonitors: true,
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
