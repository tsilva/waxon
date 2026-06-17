import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localAuthValues = new Set(["1", "true", "yes"]);
const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const isLocalAuditAuthBuild = localAuthValues.has(
  process.env.NEXT_PUBLIC_WAXON_ENABLE_LOCAL_TEST_AUTH?.trim().toLowerCase() ??
    "",
);

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
    "/api/questions/generate": ["./reference/question-quality.md"],
    "/api/submit-answer": ["./reference/question-quality.md"],
  },
  webpack(config) {
    if (isLocalAuditAuthBuild) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@clerk/nextjs$": path.join(repoRoot, "app/lib/clerkClientStub.tsx"),
        "@clerk/nextjs/server$": path.join(
          repoRoot,
          "app/lib/clerkServerStub.ts",
        ),
      };
    }

    return config;
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
