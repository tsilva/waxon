import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  getLearnerSettings,
  updateLearnerTimezone,
} from "@/app/lib/v2/settings";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json(await getLearnerSettings(user.id));
  } catch (error) {
    return v2Error(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 16 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    if (!isRecord(parsed.value)) {
      throw new Error("Settings are required.");
    }
    if (typeof parsed.value.timezone !== "string") {
      throw new Error("An IANA timezone is required.");
    }
    return NextResponse.json(
      await updateLearnerTimezone({
        userId: user.id,
        timezone: parsed.value.timezone,
      }),
    );
  } catch (error) {
    return v2Error(error);
  }
}
