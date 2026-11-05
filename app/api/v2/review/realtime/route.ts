import { NextResponse } from "next/server";
import { getCurrentLearnerId } from "@/app/lib/auth";
import { sealReviewRealtime } from "@/app/lib/v2/reviewRealtimeServer";
import { v2Error } from "@/app/lib/v2/http";

export async function GET() {
  try {
    const learnerId = await getCurrentLearnerId();
    if (!learnerId) {
      return NextResponse.json({ error: "Sign in to resume live updates." }, {
        status: 401, headers: { "Cache-Control": "private, no-store" },
      });
    }
    return NextResponse.json(await sealReviewRealtime(learnerId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return v2Error(error);
  }
}
