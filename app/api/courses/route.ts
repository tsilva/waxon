import { NextResponse } from "next/server";
import { listCourses } from "@/app/lib/courseStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
