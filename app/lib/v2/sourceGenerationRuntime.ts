import { eq } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import { getV2Db } from "@/app/db/v2/client";
import { generationRuns } from "@/app/db/v2/schema";
import { sourceGenerationWorkflow } from "./sourceGenerationWorkflow";

export async function startSourceGeneration(runId: string): Promise<string> {
  const [stored] = await getV2Db()
    .select({ workflowRunId: generationRuns.workflowRunId })
    .from(generationRuns)
    .where(eq(generationRuns.id, runId))
    .limit(1);
  if (!stored) {
    throw new Error("Generation run not found.");
  }
  if (stored.workflowRunId) {
    return stored.workflowRunId;
  }
  const run = await start(sourceGenerationWorkflow, [runId]);
  await getV2Db()
    .update(generationRuns)
    .set({ workflowRunId: run.runId, updatedAt: new Date() })
    .where(eq(generationRuns.id, runId));
  return run.runId;
}

export async function cancelSourceGenerationWorkflow(
  workflowRunId: string | null,
): Promise<void> {
  if (!workflowRunId) {
    return;
  }
  const run = getRun(workflowRunId);
  if (await run.exists) {
    await run.cancel();
  }
}
