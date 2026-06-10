import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { generateCourseToc } from "@/app/lib/courseGeneration";
import { createCourse, listCourses } from "@/app/lib/courseStore";
import { getOpenRouterChatConfig } from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_CREATE_BODY_BYTES = 16 * 1024;
const MAX_TOPIC_CHARS = 800;

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      courses: await listCourses(),
    });
  } catch (error) {
    console.info("[waxon] course listing failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });

    return NextResponse.json(
      { ok: false, error: "Could not load courses." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(
    request,
    MAX_COURSE_CREATE_BODY_BYTES,
  );

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const topic = normalizeBoundedText(payload.topic, {
    field: "topic",
    maxLength: MAX_TOPIC_CHARS,
    required: true,
  });

  if (!topic.ok) {
    return topic.response;
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
    route: "courses-create",
    rules: [
      { name: "minute", max: 2, windowMs: 60_000 },
      { name: "day", max: 20, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const toc = await generateCourseToc({
      apiKey: openRouterConfig.apiKey,
      model: openRouterConfig.model,
      topic: topic.value,
      userId: user.id,
    });
    const course = await createCourse({
      topic: topic.value,
      toc,
    });

    return NextResponse.json({
      ok: true,
      course,
    });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : "Could not create course.";
    const message = rawMessage.startsWith("Failed query:")
      ? "Could not create course."
      : rawMessage;

    console.info("[waxon] course creation failed", {
      error: rawMessage,
    });

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
