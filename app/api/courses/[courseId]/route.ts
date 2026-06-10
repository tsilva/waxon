import { NextResponse } from "next/server";
import { deleteCourse, getCourse } from "@/app/lib/courseStore";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    courseId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { courseId } = await context.params;

  let course;

  try {
    course = await getCourse(courseId);
  } catch (error) {
    console.info("[waxon] course load failed", {
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

  return NextResponse.json({
    ok: true,
    course,
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { courseId } = await context.params;

  try {
    await deleteCourse(courseId);
    invalidateReviewQueue();

    return NextResponse.json({
      ok: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not delete course.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Course not found." ? 404 : 400 },
    );
  }
}
