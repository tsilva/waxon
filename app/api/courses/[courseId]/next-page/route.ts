import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  coursePositionExists,
  type CoursePageContent,
} from "@/app/lib/courseContent";
import { generateCoursePage } from "@/app/lib/courseGeneration";
import {
  getCourse,
  getCoursePageByPosition,
  saveCoursePage,
} from "@/app/lib/courseStore";
import { getOpenRouterChatConfig } from "@/app/lib/openRouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NEXT_PAGE_BODY_BYTES = 4 * 1024;

type RouteContext = {
  params: Promise<{
    courseId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const parsed = await readJsonBodyWithLimit(request, MAX_NEXT_PAGE_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const { courseId } = await context.params;
  let course;

  try {
    course = await getCourse(courseId);
  } catch (error) {
    console.info("[waxon] course next-page load failed", {
      courseId,
      error: error instanceof Error ? error.message : "unknown error",
    });

    return NextResponse.json(
      { ok: false, error: "Could not load course." },
      { status: 500 },
    );
  }

  if (!course) {
    return NextResponse.json(
      { ok: false, error: "Course not found." },
      { status: 404 },
    );
  }

  if (course.status === "completed") {
    return NextResponse.json({
      ok: true,
      course,
      page: null,
    });
  }

  const chapterIndex = course.currentChapterIndex;
  const pageIndex = course.currentPageIndex;

  if (!coursePositionExists({ toc: course.toc, chapterIndex, pageIndex })) {
    return NextResponse.json(
      { ok: false, error: "Course position is out of range." },
      { status: 409 },
    );
  }

  const existingPage = await getCoursePageByPosition({
    courseId: course.id,
    chapterIndex,
    pageIndex,
  });

  if (existingPage) {
    return NextResponse.json({
      ok: true,
      course,
      page: existingPage,
    });
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
    route: "courses-next-page",
    rules: [
      { name: "minute", max: 4, windowMs: 60_000 },
      { name: "day", max: 80, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const previousSummaries = course.pages
      .filter(
        (page) =>
          page.chapterIndex < chapterIndex ||
          (page.chapterIndex === chapterIndex && page.pageIndex < pageIndex),
      )
      .sort(
        (left, right) =>
          left.chapterIndex - right.chapterIndex || left.pageIndex - right.pageIndex,
      )
      .map((page) => page.summary);
    const generatedPage: CoursePageContent = await generateCoursePage({
      apiKey: openRouterConfig.apiKey,
      model: openRouterConfig.model,
      userId: user.id,
      courseId: course.id,
      topic: course.topicPrompt,
      toc: course.toc,
      chapterIndex,
      pageIndex,
      previousSummaries,
    });
    const page = await saveCoursePage({
      course,
      chapterIndex,
      pageIndex,
      page: generatedPage,
    });
    const updatedCourse = await getCourse(course.id);

    return NextResponse.json({
      ok: true,
      course: updatedCourse ?? course,
      page,
    });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : "Could not generate course page.";
    const message = rawMessage.startsWith("Failed query:")
      ? "Could not generate course page."
      : rawMessage;

    console.info("[waxon] course page generation failed", {
      courseId: course.id,
      error: rawMessage,
    });

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
