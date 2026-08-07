import { NextResponse } from "next/server";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import {
  eraseSource,
  getSourceManifest,
  setSourceDisabled,
  sourceErasePreview,
} from "@/app/lib/v2/sources";
import {
  requestSourceGenerationCancellation,
  retrySourceGeneration,
} from "@/app/lib/v2/sourceGeneration";
import {
  cancelSourceGenerationWorkflow,
  startSourceGeneration,
} from "@/app/lib/v2/sourceGenerationRuntime";
import {
  buildPrerequisiteSource,
  focusSource,
  unfocusSource,
} from "@/app/lib/v2/learningPathService";
import { replanActiveSessionForFocus } from "@/app/lib/v2/service";

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
    if (parsed.value.action === "focus") {
      await focusSource({ userId: user.id, sourceId });
      await replanActiveSessionForFocus(user.id);
      return NextResponse.json({ ok: true });
    }
    if (parsed.value.action === "unfocus") {
      await unfocusSource(user.id);
      await replanActiveSessionForFocus(user.id);
      return NextResponse.json({ ok: true });
    }
    if (parsed.value.action === "build-prerequisite") {
      if (typeof parsed.value.gapNodeId !== "string") {
        throw new Error("A prerequisite gap is required.");
      }
      return NextResponse.json(
        await buildPrerequisiteSource({
          userId: user.id,
          sourceId,
          gapNodeId: parsed.value.gapNodeId,
        }),
        { status: 202 },
      );
    }
    if (parsed.value.action === "erase") {
      const cancelled = await requestSourceGenerationCancellation({
        userId: user.id,
        sourceId,
        allowMissing: true,
      });
      await cancelSourceGenerationWorkflow(cancelled.workflowRunId);
      await eraseSource({ userId: user.id, sourceId });
    } else if (parsed.value.action === "retry") {
      const retried = await retrySourceGeneration({ userId: user.id, sourceId });
      const workflowRunId = await startSourceGeneration(retried.runId);
      return NextResponse.json({ ok: true, ...retried, workflowRunId });
    } else if (parsed.value.action === "cancel") {
      const cancelled = await requestSourceGenerationCancellation({
        userId: user.id,
        sourceId,
      });
      await cancelSourceGenerationWorkflow(cancelled.workflowRunId);
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
