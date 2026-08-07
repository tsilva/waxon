import { start } from "workflow/api";
import { backgroundJobWorkflow } from "./backgroundJobWorkflow";

export async function startBackgroundJobs(
  userId: string,
  limit = 8,
): Promise<string> {
  const run = await start(backgroundJobWorkflow, [userId, limit]);
  return run.runId;
}
