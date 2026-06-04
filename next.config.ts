import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingIncludes: {
    "/api/questions/generate": ["./reference/question-quality.md"],
    "/api/submit-answer": ["./reference/question-quality.md"],
  },
};

export default nextConfig;
