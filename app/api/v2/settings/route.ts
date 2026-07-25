import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  getLearnerSettings,
  updateLearnerSettings,
} from "@/app/lib/v2/service";

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
    return NextResponse.json(
      await updateLearnerSettings({
        userId: user.id,
        dailyMinutes:
          typeof parsed.value.dailyMinutes === "number"
            ? parsed.value.dailyMinutes
            : undefined,
        desiredRetention:
          typeof parsed.value.desiredRetention === "number"
            ? parsed.value.desiredRetention
            : undefined,
        newItemsPerDay:
          typeof parsed.value.newItemsPerDay === "number"
            ? parsed.value.newItemsPerDay
            : undefined,
        timezone:
          typeof parsed.value.timezone === "string"
            ? parsed.value.timezone
            : undefined,
      }),
    );
  } catch (error) {
    return v2Error(error);
  }
}
