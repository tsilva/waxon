import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  devIndicators: false,
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
  org: "tsilva",
  project: "waxon",
  silent: !process.env.CI,
  sourcemaps: {
    disable: true,
  },
  tunnelRoute: "/monitoring",

  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
