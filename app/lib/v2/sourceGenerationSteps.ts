import {
  critiqueGenerationRunStep as critiqueGenerationRun,
  failGenerationRunStep as failGenerationRun,
  finalizeGenerationRunStep as finalizeGenerationRun,
  indexGeneratedQuestionsStep as indexGeneratedQuestions,
  mapGenerationChunkStep as mapGenerationChunk,
  matchGenerationRunStep as matchGenerationRun,
  persistGenerationRunStep as persistGenerationRun,
  prepareGenerationRunStep as prepareGenerationRun,
  reuseGenerationManifestStep as reuseGenerationManifest,
} from "./sourceGeneration";

export async function prepareGenerationRunStep(runId: string) {
  "use step";
  return await prepareGenerationRun(runId);
}

export async function reuseGenerationManifestStep(
  runId: string,
  sourceRunId: string,
) {
  "use step";
  return await reuseGenerationManifest(runId, sourceRunId);
}

export async function mapGenerationChunkStep(runId: string, chunkKey: string) {
  "use step";
  return await mapGenerationChunk(runId, chunkKey);
}

export async function critiqueGenerationRunStep(runId: string) {
  "use step";
  return await critiqueGenerationRun(runId);
}

export async function matchGenerationRunStep(runId: string) {
  "use step";
  return await matchGenerationRun(runId);
}

export async function persistGenerationRunStep(runId: string) {
  "use step";
  return await persistGenerationRun(runId);
}

export async function indexGeneratedQuestionsStep(runId: string) {
  "use step";
  return await indexGeneratedQuestions(runId);
}

export async function finalizeGenerationRunStep(runId: string) {
  "use step";
  return await finalizeGenerationRun(runId);
}

export async function failGenerationRunStep(runId: string, message: string) {
  "use step";
  return await failGenerationRun(runId, message);
}
