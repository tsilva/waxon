import { after, NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  continueSourceAnalysis,
  eraseSource,
  getSourceManifest,
  mutateSourceProcessing,
  setSourceDisabled,
  sourceErasePreview,
} from "@/app/lib/v2/sources";
import { runPendingJobs } from "@/app/lib/v2/service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  try {
    const user = await getCurrentUser();
    const { sourceId } = await context.params;
    return NextResponse.json(await getSourceManifest(user.id, sourceId));
  } catch (error) {
    return v2Error(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  const parsed = await readJsonBodyWithLimit(request, 8 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    const { sourceId } = await context.params;
    if (!isRecord(parsed.value) || typeof parsed.value.action !== "string") {
      throw new Error("A source action is required.");
    }
    if (parsed.value.action === "preview-erase") {
      return NextResponse.json(await sourceErasePreview(user.id, sourceId));
    }
    if (parsed.value.action === "erase") {
      await eraseSource({ userId: user.id, sourceId });
    } else if (parsed.value.action === "continue") {
      await continueSourceAnalysis({ userId: user.id, sourceId });
      after(() => runPendingJobs({ userId: user.id, limit: 2 }));
    } else if (
      parsed.value.action === "retry" ||
      parsed.value.action === "cancel"
    ) {
      await mutateSourceProcessing({
        userId: user.id,
        sourceId,
        action: parsed.value.action,
      });
    } else if (
      parsed.value.action === "disable" ||
      parsed.value.action === "enable"
    ) {
      await setSourceDisabled({
        userId: user.id,
        sourceId,
        disabled: parsed.value.action === "disable",
      });
    } else {
      throw new Error("This source action is not allowed.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return v2Error(error);
  }
}
