import { NextResponse } from "next/server";
import { getCourse } from "@/app/lib/courseStore";

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
