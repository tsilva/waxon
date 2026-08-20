import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  actOnReviewItem,
  getOrCreateReviewSession,
} from "@/app/lib/v2/service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getOrCreateReviewSession(user.id));
  } catch (error) {
    return v2Error(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const user = await getCurrentUser();
    if (!isRecord(parsed.value)) throw new Error("A Review action is required.");
    const itemId = typeof parsed.value.itemId === "string" ? parsed.value.itemId : "";
    const action = parsed.value.action;
    if (!itemId) throw new Error("A Review item is required.");
    if (action !== "flag" && action !== "next") {
      throw new Error("This Review action is not allowed.");
    }
    return NextResponse.json(
      await actOnReviewItem({ userId: user.id, itemId, action }),
    );
  } catch (error) {
    return v2Error(error);
  }
}
