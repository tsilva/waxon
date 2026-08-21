import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export function v2Error(error: unknown): NextResponse {
  Sentry.captureException(error, { tags: { waxon_version: "v2" } });
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred.";
  const status = /not found/iu.test(message)
    ? 404
    : /no longer|conflict|duplicate|idempotency|already exists/iu.test(message)
      ? 409
      : /required|choose|must|allowed|larger|enough readable/iu.test(message)
        ? 400
        : 500;

  return NextResponse.json({ ok: false, error: message }, { status });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asGrade(
  value: unknown,
): "again" | "hard" | "good" | "easy" | null {
  return value === "again" ||
    value === "hard" ||
    value === "good" ||
    value === "easy"
    ? value
    : null;
}
