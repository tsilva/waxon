import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { deleteCourse, getCourse } from "@/app/lib/courseStore";

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
    const user = await getCurrentUser();
    course = await getCourse({ courseId, userId: user.id });
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
    const user = await getCurrentUser();
    await deleteCourse({ courseId, userId: user.id });

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
