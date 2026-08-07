import {
  critiqueGenerationRunStep,
  failGenerationRunStep,
  finalizeGenerationRunStep,
  indexGeneratedQuestionsStep,
  mapGenerationChunkStep,
  matchGenerationRunStep,
  persistGenerationRunStep,
  prepareGenerationRunStep,
  reuseGenerationManifestStep,
} from "./sourceGenerationSteps";

const MAX_CONCURRENT_MODEL_CALLS = 4;

export async function sourceGenerationWorkflow(runId: string): Promise<void> {
  "use workflow";

  try {
    const prepared = await prepareGenerationRunStep(runId);
    if (prepared.cancelled) {
      return;
    }
    if (prepared.reuseManifestFromRunId) {
      await reuseGenerationManifestStep(runId, prepared.reuseManifestFromRunId);
    } else {
      for (
        let offset = 0;
        offset < prepared.chunkKeys.length;
        offset += MAX_CONCURRENT_MODEL_CALLS
      ) {
        const batch = prepared.chunkKeys.slice(
          offset,
          offset + MAX_CONCURRENT_MODEL_CALLS,
        );
        await Promise.all(
          batch.map((chunkKey) => mapGenerationChunkStep(runId, chunkKey)),
        );
      }
      await critiqueGenerationRunStep(runId);
    }
    await matchGenerationRunStep(runId);
    await persistGenerationRunStep(runId);
    await indexGeneratedQuestionsStep(runId);
    await finalizeGenerationRunStep(runId);
  } catch (error) {
    await failGenerationRunStep(
      runId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
