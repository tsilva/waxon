import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingIncludes: {
    "/api/submit-answer": ["./reference/question-quality.md"],
  },
};

export default nextConfig;
