import { runPendingJobs } from "./service";

export async function runPendingJobsStep(userId: string, limit: number) {
  "use step";
  return await runPendingJobs({ userId, limit });
}
