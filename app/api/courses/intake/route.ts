import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  generateCourseIntakeDecision,
  type CourseIntakeMessage,
} from "@/app/lib/courseGeneration";
import { getOpenRouterChatConfig } from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_INTAKE_BODY_BYTES = 16 * 1024;
const MAX_INTAKE_MESSAGES = 8;
const MAX_INTAKE_MESSAGE_CHARS = 800;

function normalizeMessages(value: unknown): CourseIntakeMessage[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const messages = value.slice(-MAX_INTAKE_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const role: CourseIntakeMessage["role"] =
      record.role === "assistant" ? "assistant" : "user";
    const content =
      typeof record.content === "string"
        ? record.content.trim().slice(0, MAX_INTAKE_MESSAGE_CHARS)
        : "";

    return content ? [{ role, content }] : [];
  });

  return messages.length > 0 ? messages : null;
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(
    request,
    MAX_COURSE_INTAKE_BODY_BYTES,
  );

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const messages = normalizeMessages(payload.messages);

  if (!messages) {
    return NextResponse.json(
      { ok: false, error: "messages are required." },
      { status: 400 },
    );
  }

  const openRouterConfig = getOpenRouterChatConfig();

  if (!openRouterConfig.ok) {
    return NextResponse.json(
      { ok: false, error: openRouterConfig.error },
      { status: 500 },
    );
  }

  const user = await getCurrentUser();
  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "courses-intake",
    rules: [
      { name: "minute", max: 8, windowMs: 60_000 },
      { name: "day", max: 80, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const decision = await generateCourseIntakeDecision({
      apiKey: openRouterConfig.apiKey,
      model: openRouterConfig.model,
      userId: user.id,
      messages,
    });

    return NextResponse.json({
      ok: true,
      decision,
    });
  } catch (error) {
    console.info("[waxon] course intake failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });

    return NextResponse.json(
      { ok: false, error: "Could not continue Learn chat." },
      { status: 500 },
    );
  }
}
