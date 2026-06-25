import { NextResponse } from "next/server";
import { listCoursesPage, type CourseListCursor } from "@/app/lib/courseStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_COURSE_PAGE_SIZE = 8;
const MAX_COURSE_PAGE_SIZE = 50;

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCourseCursor(searchParams: URLSearchParams): CourseListCursor | null {
  const cursorUpdatedAtValue = searchParams.get("cursorUpdatedAt");
  const cursorId = searchParams.get("cursorId");

  if (!cursorUpdatedAtValue && !cursorId) {
    return null;
  }

  const cursorUpdatedAt = Number(cursorUpdatedAtValue);

  if (!Number.isFinite(cursorUpdatedAt) || cursorUpdatedAt <= 0 || !cursorId) {
    throw new Error("Invalid course cursor.");
  }

  return {
    updatedAt: cursorUpdatedAt,
    id: cursorId,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      parsePositiveInteger(searchParams.get("limit"), DEFAULT_COURSE_PAGE_SIZE),
      MAX_COURSE_PAGE_SIZE,
    );
    const search = searchParams.get("search")?.trim().slice(0, 160) ?? "";
    const page = await listCoursesPage({
      cursor: parseCourseCursor(searchParams),
      limit,
      search,
    });

    return NextResponse.json({
      ok: true,
      courses: page.courses,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
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
