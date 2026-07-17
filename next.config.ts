import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  htmlLimitedBots: /.*/,
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

export default withSentryConfig(nextConfig, {
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
