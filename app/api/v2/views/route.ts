import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  createSavedView,
  deleteSavedView,
} from "@/app/lib/v2/service";
import type { V2Lifecycle } from "@/app/lib/v2/types";

const LIFECYCLES = new Set([
  "all",
  "draft",
  "new",
  "learning",
  "review",
  "paused",
  "archived",
  "suspended",
  "trash",
  "superseded",
]);

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 16 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    if (!isRecord(parsed.value)) {
      throw new Error("A saved view is required.");
    }
    const lifecycle =
      typeof parsed.value.lifecycle === "string" &&
      LIFECYCLES.has(parsed.value.lifecycle)
        ? (parsed.value.lifecycle as V2Lifecycle | "all")
        : "all";
    const view = await createSavedView({
      userId: user.id,
      name:
        typeof parsed.value.name === "string" ? parsed.value.name : "",
      search:
        typeof parsed.value.search === "string" ? parsed.value.search : "",
      lifecycle,
    });
    return NextResponse.json({ ok: true, view }, { status: 201 });
  } catch (error) {
    return v2Error(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser();
    const viewId = new URL(request.url).searchParams.get("viewId") ?? "";
    await deleteSavedView({ userId: user.id, viewId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return v2Error(error);
  }
}
