import { NextResponse } from "next/server";
import {
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { answerCoursePage } from "@/app/lib/courseStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COURSE_ANSWER_BODY_BYTES = 4 * 1024;
const MAX_ID_CHARS = 120;

type RouteContext = {
  params: Promise<{
    courseId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const parsed = await readJsonBodyWithLimit(
    request,
    MAX_COURSE_ANSWER_BODY_BYTES,
  );

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const pageId = normalizeBoundedText(payload.pageId, {
    field: "pageId",
    maxLength: MAX_ID_CHARS,
    required: true,
  });
  const selectedChoiceId = normalizeBoundedText(payload.selectedChoiceId, {
    field: "selectedChoiceId",
    maxLength: MAX_ID_CHARS,
    required: true,
  });

  if (!pageId.ok) {
    return pageId.response;
  }

  if (!selectedChoiceId.ok) {
    return selectedChoiceId.response;
  }

  try {
    const { courseId } = await context.params;
    const result = await answerCoursePage({
      courseId,
      pageId: pageId.value,
      selectedChoiceId: selectedChoiceId.value,
    });

    if (!result) {
      return NextResponse.json(
        { ok: false, error: "Course page not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error &&
      error.message === "Selected choice does not exist."
        ? error.message
        : "Could not submit answer.";

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
