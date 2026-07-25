import { after, NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { v2Error } from "@/app/lib/v2/http";
import {
  getOrCreateReviewSession,
  runPendingJobs,
} from "@/app/lib/v2/service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    after(() => runPendingJobs({ userId: user.id, limit: 4 }));
    return NextResponse.json(await getOrCreateReviewSession(user.id));
  } catch (error) {
    return v2Error(error);
  }
}
