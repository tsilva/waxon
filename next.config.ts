import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.NEXT_DEV_OUTPUT_DIR || ".next",
  htmlLimitedBots: /.*/,
  webpack(config) {
    config.module.rules.push({
      test: /\.mts$/u,
      use: [
        {
          loader: new URL("./scripts/lib/next-mts-loader.mjs", import.meta.url)
            .pathname,
        },
      ],
    });

    return config;
  },
  async headers() {
    return [
      {
        source: "/landing/:asset(practice-journal-hero-\\d+\\.[a-f0-9]{12}\\.avif)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  outputFileTracingIncludes: {
    "/api/:path*": ["./prompts/**/*.md", "./reference/question-quality.md"],
  },
};

const isHostedBuild = process.env.VERCEL === "1" && Boolean(process.env.VERCEL_DEPLOYMENT_ID);

export default withSentryConfig(withWorkflow(nextConfig), {
  useRunAfterProductionCompileHook: isHostedBuild ? undefined : false,
  authToken: isHostedBuild ? process.env.SENTRY_AUTH_TOKEN : undefined,
  org: "tsilva",
  project: "waxon",
  silent: !process.env.CI,
  sourcemaps: {
    disable: !isHostedBuild || !process.env.SENTRY_AUTH_TOKEN,
  },
  widenClientFileUpload: Boolean(process.env.SENTRY_AUTH_TOKEN),
  tunnelRoute: "/monitoring",

  webpack: {
    disableSentryConfig: !isHostedBuild,
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
