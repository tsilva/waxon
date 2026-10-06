import { withSentryConfig } from "@sentry/nextjs";
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

export default withSentryConfig(withWorkflow(nextConfig), {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: "tsilva",
  project: "waxon",
  silent: !process.env.CI,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  widenClientFileUpload: Boolean(process.env.SENTRY_AUTH_TOKEN),
  tunnelRoute: "/monitoring",

  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
