import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { v2Error } from "@/app/lib/v2/http";
import { runPendingJobs } from "@/app/lib/v2/service";

export async function POST() {
  try {
    const user = await getCurrentUser();
    const processed = await runPendingJobs({ userId: user.id, limit: 10 });
    return NextResponse.json({ ok: true, processed });
  } catch (error) {
    return v2Error(error);
  }
}
