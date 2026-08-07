import { runPendingJobsStep } from "./backgroundJobSteps";

export async function backgroundJobWorkflow(
  userId: string,
  limit = 8,
): Promise<void> {
  "use workflow";

  for (let pass = 0; pass < 3; pass += 1) {
    const processed = await runPendingJobsStep(userId, limit);
    if (processed === 0) {
      return;
    }
  }
}
