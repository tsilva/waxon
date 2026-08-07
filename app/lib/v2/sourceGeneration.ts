import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getV2Client, getV2Db } from "@/app/db/v2/client";
import {
  conceptAliases,
  concepts,
  coverageTargets,
  evidenceSpans,
  generationRunArtifacts,
  generationRuns,
  jobs,
  learnerSettings,
  questionConcepts,
  questionEmbeddings,
  questionEvidence,
  questions,
  questionVersions,
  sourceLearningEdges,
  sourceLearningNodes,
  sourceLearningPaths,
  sourceMaterials,
  sources,
  sourceVersions,
  targetEvidence,
  targetQuestions,
} from "@/app/db/v2/schema";
import { embedTexts } from "./model";
import {
  EMPTY_GENERATION_USAGE,
  critiqueMasteryManifest,
  generateTopicBrief,
  judgeExistingCoverage,
  mapMasteryChunk,
  resolveSourceAgentModels,
  sequenceLearningPath,
  type GenerationUsage,
  type MasteryTargetDraft,
} from "./sourceAgentModel";
import {
  normalizeLearningPath,
  removeSharedQuestionEdges,
  type SequenceDraft,
  type SequenceTarget,
} from "./learningPath";
import {
  conceptSlug,
  loadSourceText,
  readableText,
} from "./sources";
import {
  assessQuestionQuality,
  recallTargetKey,
} from "./questionQuality";
import { claimV2Job } from "./jobs";

export const SOURCE_AGENT_POLICY_VERSION = "source-mastery-v6";
export const SOURCE_GENERATION_BUDGET = {
  modelCalls: 14,
  inputTokens: 250_000,
  outputTokens: 40_000,
  webSearches: 3,
  webResults: 12,
  criticRounds: 2,
  maxTargets: 120,
  maxConcurrentModelCalls: 4,
  maxWallClockSeconds: 600,
} as const;

const ACTIVE_RUN_STATUSES = [
  "queued",
  "preparing",
  "mapping",
  "matching",
  "drafting",
  "criticizing",
  "persisting",
] as const;
const ACTIVE_QUESTION_LIFECYCLES = ["new", "learning", "review"] as const;
const MAX_SOURCE_CHARS = 1_000_000;
const TARGET_CHUNK_CHARS = 120_000;
const MAX_CHUNKS = 8;

type SourceKind = "paste" | "url" | "pdf" | "text" | "topic";
type RunStatus = (typeof generationRuns.$inferSelect)["status"];

type MatchPlanItem = {
  target: MasteryTargetDraft;
  action: "reuse" | "generate" | "inactive" | "uncertain";
  questionId: string | null;
  reason: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function serializeInput(input: {
  kind: SourceKind;
  title: string;
  rawText?: string | null;
  originalUrl?: string | null;
  objectUrl?: string | null;
  mimeType?: string | null;
  byteSize?: number;
}): string {
  if (input.kind === "paste" || input.kind === "topic") {
    return input.rawText?.trim() ?? "";
  }
  if (input.kind === "url") {
    return input.originalUrl?.trim() ?? "";
  }
  return JSON.stringify({
    fileName: input.title,
    mimeType: input.mimeType ?? "application/octet-stream",
    byteSize: input.byteSize ?? 0,
    objectUrl: input.objectUrl ?? null,
  });
}

export async function createSourceGeneration(input: {
  userId: string;
  kind: SourceKind;
  title: string;
  rawText?: string | null;
  originalUrl?: string | null;
  objectUrl?: string | null;
  mimeType?: string | null;
  byteSize?: number;
  contentChecksum?: string;
}): Promise<{
  sourceId: string;
  revisionId: string;
  runId: string;
  status: "queued";
  reused: boolean;
}> {
  const title = input.title.trim().slice(0, 300) || "Untitled source";
  const snapshot = serializeInput({ ...input, title });
  if (input.kind === "topic" && snapshot.length < 3) {
    throw new Error("Describe the topic you want to learn.");
  }
  if (input.kind === "paste" && snapshot.length < 40) {
    throw new Error("Paste at least 40 characters of source material.");
  }
  if (!snapshot) {
    throw new Error("The source does not contain readable input.");
  }
  const identityChecksum =
    input.contentChecksum ?? sha256(`${input.kind}:${snapshot}`);
  const db = getV2Db();
  const pool = getV2Client().pool;
  const capacity = await pool.query<{
    bytes: string;
    source_count: string;
    active_runs: string;
  }>(
    `SELECT
       COALESCE((SELECT sum(byte_size) FROM waxon_v2.sources WHERE user_id = $1), 0)::text AS bytes,
       (SELECT count(*) FROM waxon_v2.sources WHERE user_id = $1)::text AS source_count,
       (SELECT count(*) FROM waxon_v2.generation_runs
         WHERE user_id = $1
           AND status IN ('queued','preparing','mapping','matching','drafting','criticizing','persisting'))::text AS active_runs`,
    [input.userId],
  );
  const usage = capacity.rows[0];
  if (Number(usage?.bytes ?? 0) + (input.byteSize ?? 0) > 2 * 1024 ** 3) {
    throw new Error("Your 2 GB source-storage limit is full.");
  }
  if (Number(usage?.source_count ?? 0) >= 10_000) {
    throw new Error("Your source limit is full.");
  }
  if (Number(usage?.active_runs ?? 0) >= 20) {
    throw new Error("Too many source preparations are already running.");
  }
  const { model, criticModel } = resolveSourceAgentModels();

  return await db.transaction(async (tx) => {
    const [existingSource] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, input.userId),
          eq(sources.kind, input.kind),
          eq(sources.checksum, identityChecksum),
        ),
      )
      .limit(1);

    let sourceId: string;
    let revisionId: string;
    let reused = false;
    if (existingSource) {
      sourceId = existingSource.id;
      reused = true;
      const [active] = await tx
        .select({ id: generationRuns.id, revisionId: generationRuns.sourceRevisionId })
        .from(generationRuns)
        .where(
          and(
            eq(generationRuns.userId, input.userId),
            eq(generationRuns.sourceId, sourceId),
            inArray(generationRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .orderBy(desc(generationRuns.createdAt))
        .limit(1);
      if (active) {
        return {
          sourceId,
          revisionId: active.revisionId,
          runId: active.id,
          status: "queued" as const,
          reused: true,
        };
      }
      const [revision] = await tx
        .select({ id: sourceVersions.id })
        .from(sourceVersions)
        .where(
          and(
            eq(sourceVersions.userId, input.userId),
            eq(sourceVersions.sourceId, sourceId),
          ),
        )
        .orderBy(desc(sourceVersions.version))
        .limit(1);
      if (!revision) {
        throw new Error("The existing source revision is missing.");
      }
      revisionId = revision.id;
    } else {
      const [source] = await tx
        .insert(sources)
        .values({
          userId: input.userId,
          kind: input.kind,
          status: "captured",
          title,
          originalUrl: input.originalUrl,
          objectUrl: input.objectUrl,
          mimeType: input.mimeType,
          byteSize:
            input.byteSize ?? Buffer.byteLength(input.rawText ?? snapshot, "utf8"),
          checksum: identityChecksum,
          rawText:
            input.kind === "paste" || input.kind === "topic"
              ? input.rawText?.trim()
              : null,
        })
        .returning({ id: sources.id });
      sourceId = source.id;
      const [revision] = await tx
        .insert(sourceVersions)
        .values({
          userId: input.userId,
          sourceId,
          version: 1,
          bodyText: snapshot,
          checksum: sha256(snapshot),
        })
        .returning({ id: sourceVersions.id });
      revisionId = revision.id;
      await tx.insert(sourceMaterials).values({
        userId: input.userId,
        sourceRevisionId: revisionId,
        kind: "input",
        title,
        bodyText: snapshot,
        url: input.originalUrl,
        checksum: sha256(snapshot),
        metadata: { sourceKind: input.kind },
      });
      await tx
        .update(sources)
        .set({ activeRevisionId: revisionId, updatedAt: new Date() })
        .where(eq(sources.id, sourceId));
    }

    const [run] = await tx
      .insert(generationRuns)
      .values({
        userId: input.userId,
        sourceId,
        sourceRevisionId: revisionId,
        status: "queued",
        stage: "Queued",
        policyVersion: SOURCE_AGENT_POLICY_VERSION,
        model,
        criticModel,
        budget: { ...SOURCE_GENERATION_BUDGET },
      })
      .returning({ id: generationRuns.id });
    await tx
      .update(sources)
      .set({
        status: "captured",
        activeRevisionId: revisionId,
        activeRunId: run.id,
        processingProgress: 0,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));

    return {
      sourceId,
      revisionId,
      runId: run.id,
      status: "queued" as const,
      reused,
    };
  });
}

export async function requestSourceGenerationCancellation(input: {
  userId: string;
  sourceId: string;
  allowMissing?: boolean;
}): Promise<{ workflowRunId: string | null }> {
  const db = getV2Db();
  return await db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: generationRuns.id,
        workflowRunId: generationRuns.workflowRunId,
        status: generationRuns.status,
      })
      .from(generationRuns)
      .where(
        and(
          eq(generationRuns.userId, input.userId),
          eq(generationRuns.sourceId, input.sourceId),
          inArray(generationRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(generationRuns.createdAt))
      .limit(1);
    if (!run) {
      if (input.allowMissing) {
        return { workflowRunId: null };
      }
      throw new Error("This source is not currently being prepared.");
    }
    await tx
      .update(generationRuns)
      .set({
        status: "cancelled",
        stage: "Cancelled",
        cancelRequestedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generationRuns.id, run.id));
    await tx
      .update(sources)
      .set({
        status: "cancelled",
        error: "Preparation cancelled. Retry whenever you are ready.",
        updatedAt: new Date(),
      })
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      );
    return { workflowRunId: run.workflowRunId };
  });
}

export async function retrySourceGeneration(input: {
  userId: string;
  sourceId: string;
}): Promise<{ runId: string; revisionId: string }> {
  const db = getV2Db();
  const { model, criticModel } = resolveSourceAgentModels();
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM waxon_v2.sources
           WHERE user_id = ${input.userId} AND id = ${input.sourceId}
           FOR UPDATE`,
    );
    const [source] = await tx
      .select({
        id: sources.id,
        activeRevisionId: sources.activeRevisionId,
        status: sources.status,
      })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!source) {
      throw new Error("Source not found.");
    }
    if (source.status === "disabled") {
      throw new Error("Enable this source before retrying preparation.");
    }
    const [active] = await tx
      .select({ id: generationRuns.id })
      .from(generationRuns)
      .where(
        and(
          eq(generationRuns.userId, input.userId),
          eq(generationRuns.sourceId, input.sourceId),
          inArray(generationRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (active) {
      throw new Error("This source is already being prepared.");
    }
    const revisionId =
      source.activeRevisionId ??
      (await tx
        .select({ id: sourceVersions.id })
        .from(sourceVersions)
        .where(
          and(
            eq(sourceVersions.userId, input.userId),
            eq(sourceVersions.sourceId, input.sourceId),
          ),
        )
        .orderBy(desc(sourceVersions.version))
        .limit(1)
        .then((rows) => rows[0]?.id ?? null));
    if (!revisionId) {
      throw new Error("The source revision required for retry is missing.");
    }
    const [run] = await tx
      .insert(generationRuns)
      .values({
        userId: input.userId,
        sourceId: input.sourceId,
        sourceRevisionId: revisionId,
        status: "queued",
        stage: "Queued",
        policyVersion: SOURCE_AGENT_POLICY_VERSION,
        model,
        criticModel,
        budget: { ...SOURCE_GENERATION_BUDGET },
      })
      .returning({ id: generationRuns.id });
    await tx
      .update(sources)
      .set({
        status: "captured",
        activeRunId: run.id,
        processingProgress: 0,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, input.sourceId));
    return { runId: run.id, revisionId };
  });
}

async function runContext(runId: string) {
  const db = getV2Db();
  const [row] = await db
    .select({
      run: generationRuns,
      source: sources,
      revision: sourceVersions,
    })
    .from(generationRuns)
    .innerJoin(
      sources,
      and(
        eq(sources.userId, generationRuns.userId),
        eq(sources.id, generationRuns.sourceId),
      ),
    )
    .innerJoin(
      sourceVersions,
      and(
        eq(sourceVersions.userId, generationRuns.userId),
        eq(sourceVersions.id, generationRuns.sourceRevisionId),
      ),
    )
    .where(eq(generationRuns.id, runId))
    .limit(1);
  if (!row) {
    throw new Error("Generation run not found.");
  }
  return row;
}

async function existingArtifact(runId: string, kind: string, artifactKey: string) {
  const db = getV2Db();
  const [artifact] = await db
    .select()
    .from(generationRunArtifacts)
    .where(
      and(
        eq(generationRunArtifacts.generationRunId, runId),
        eq(generationRunArtifacts.kind, kind),
        eq(generationRunArtifacts.artifactKey, artifactKey),
      ),
    )
    .limit(1);
  return artifact ?? null;
}

async function writeArtifact(input: {
  userId: string;
  runId: string;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  usage?: GenerationUsage;
}) {
  await getV2Db()
    .insert(generationRunArtifacts)
    .values({
      userId: input.userId,
      generationRunId: input.runId,
      kind: input.kind,
      artifactKey: input.key,
      payload: input.payload,
      usage: input.usage ?? EMPTY_GENERATION_USAGE,
    })
    .onConflictDoNothing();
}

async function totalUsage(runId: string): Promise<GenerationUsage> {
  const artifacts = await getV2Db()
    .select({ usage: generationRunArtifacts.usage })
    .from(generationRunArtifacts)
    .where(eq(generationRunArtifacts.generationRunId, runId));
  return artifacts.reduce<GenerationUsage>(
    (total, row) => ({
      modelCalls: total.modelCalls + Number(row.usage.modelCalls ?? 0),
      inputTokens: total.inputTokens + Number(row.usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + Number(row.usage.outputTokens ?? 0),
      totalTokens: total.totalTokens + Number(row.usage.totalTokens ?? 0),
      cost: total.cost + Number(row.usage.cost ?? 0),
      webSearches: total.webSearches + Number(row.usage.webSearches ?? 0),
    }),
    { ...EMPTY_GENERATION_USAGE },
  );
}

async function markCancelled(runId: string): Promise<boolean> {
  const context = await runContext(runId);
  if (!context.run.cancelRequestedAt && context.run.status !== "cancelled") {
    return false;
  }
  await getV2Db().transaction(async (tx) => {
    await tx
      .update(generationRuns)
      .set({
        status: "cancelled",
        stage: "Cancelled",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generationRuns.id, runId));
    await tx
      .update(sources)
      .set({
        status: "cancelled",
        error: "Preparation cancelled. Retry whenever you are ready.",
        updatedAt: new Date(),
      })
      .where(eq(sources.id, context.source.id));
  });
  return true;
}

async function updateRunStage(
  runId: string,
  status: RunStatus,
  stage: string,
  progress: number,
) {
  const usage = await totalUsage(runId);
  await getV2Db()
    .update(generationRuns)
    .set({
      status,
      stage,
      progress,
      usage,
      startedAt: status === "preparing" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(generationRuns.id, runId));
}

function chunkText(text: string): Array<{ start: number; end: number }> {
  const usable = text.slice(0, MAX_SOURCE_CHARS);
  const desiredCount = Math.max(1, Math.ceil(usable.length / TARGET_CHUNK_CHARS));
  const count = Math.min(MAX_CHUNKS, desiredCount);
  const size = Math.ceil(usable.length / count);
  return Array.from({ length: count }, (_, index) => ({
    start: index * size,
    end: Math.min(usable.length, (index + 1) * size),
  })).filter((item) => item.end > item.start);
}

export async function prepareGenerationRunStep(runId: string): Promise<{
  cancelled: boolean;
  chunkKeys: string[];
  reuseManifestFromRunId: string | null;
}> {
  if (await markCancelled(runId)) {
    return { cancelled: true, chunkKeys: [], reuseManifestFromRunId: null };
  }
  const context = await runContext(runId);
  await updateRunStage(runId, "preparing", "Preparing source", 8);

  const [cached] = await getV2Db()
    .select({ id: generationRuns.id })
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.userId, context.run.userId),
        eq(generationRuns.sourceRevisionId, context.run.sourceRevisionId),
        eq(generationRuns.policyVersion, context.run.policyVersion),
        eq(generationRuns.status, "ready"),
        sql`${generationRuns.manifest} IS NOT NULL`,
        sql`${generationRuns.id} <> ${runId}`,
      ),
    )
    .orderBy(desc(generationRuns.createdAt))
    .limit(1);
  if (cached) {
    return {
      cancelled: false,
      chunkKeys: [],
      reuseManifestFromRunId: cached.id,
    };
  }

  let primaryMaterial = await getV2Db()
    .select()
    .from(sourceMaterials)
    .where(
      and(
        eq(sourceMaterials.userId, context.run.userId),
        eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
        context.source.kind === "topic"
          ? and(
              eq(sourceMaterials.kind, "model_synthesis"),
              sql`${sourceMaterials.metadata}->>'policyVersion' = ${context.run.policyVersion}`,
            )
          : eq(sourceMaterials.kind, "extracted"),
      ),
    )
    .orderBy(desc(sourceMaterials.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!primaryMaterial && context.source.kind === "topic") {
    const topic = await generateTopicBrief({
      userId: context.run.userId,
      topic: context.revision.bodyText.slice(0, 2_000),
    });
    const [material] = await getV2Db()
      .insert(sourceMaterials)
      .values({
        userId: context.run.userId,
        sourceRevisionId: context.run.sourceRevisionId,
        kind: "model_synthesis",
        title: topic.title,
        bodyText: topic.body,
        model: context.run.model,
        checksum: sha256(topic.body),
        metadata: {
          usedResearch: topic.usedResearch,
          policyVersion: context.run.policyVersion,
        },
      })
      .onConflictDoUpdate({
        target: [
          sourceMaterials.userId,
          sourceMaterials.sourceRevisionId,
          sourceMaterials.kind,
          sourceMaterials.checksum,
        ],
        set: {
          title: topic.title,
          model: context.run.model,
          metadata: {
            usedResearch: topic.usedResearch,
            policyVersion: context.run.policyVersion,
          },
        },
      })
      .returning();
    primaryMaterial =
      material ??
      (await getV2Db()
        .select()
        .from(sourceMaterials)
        .where(
          and(
            eq(sourceMaterials.userId, context.run.userId),
            eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
            eq(sourceMaterials.kind, "model_synthesis"),
            sql`${sourceMaterials.metadata}->>'policyVersion' = ${context.run.policyVersion}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null));
    for (const citation of topic.citations) {
      const citationBody = citation.content || `${citation.title}\n${citation.url}`;
      await getV2Db()
        .insert(sourceMaterials)
        .values({
          userId: context.run.userId,
          sourceRevisionId: context.run.sourceRevisionId,
          kind: "web",
          title: citation.title,
          bodyText: citationBody,
          url: citation.url,
          checksum: sha256(`${citation.url}:${citationBody}`),
          metadata: { capturedBy: "openrouter:web_search" },
        })
        .onConflictDoNothing();
    }
    await writeArtifact({
      userId: context.run.userId,
      runId,
      kind: "topic_brief",
      key: "primary",
      payload: {
        materialId: primaryMaterial?.id ?? null,
        usedResearch: topic.usedResearch,
        citations: topic.citations.length,
      },
      usage: topic.usage,
    });
  }

  if (!primaryMaterial) {
    const body = readableText(await loadSourceText(context.source))
      .replace(/\u0000/gu, "")
      .trim();
    if (body.length < 40) {
      throw new Error("The source did not contain enough readable text.");
    }
    const [material] = await getV2Db()
      .insert(sourceMaterials)
      .values({
        userId: context.run.userId,
        sourceRevisionId: context.run.sourceRevisionId,
        kind: "extracted",
        title: context.source.title,
        bodyText: body,
        url: context.source.originalUrl,
        checksum: sha256(body),
        metadata: { sourceKind: context.source.kind },
      })
      .onConflictDoNothing()
      .returning();
    primaryMaterial =
      material ??
      (await getV2Db()
        .select()
        .from(sourceMaterials)
        .where(
          and(
            eq(sourceMaterials.userId, context.run.userId),
            eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
            eq(sourceMaterials.kind, "extracted"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null));
    await getV2Db()
      .update(sources)
      .set({ rawText: body, updatedAt: new Date() })
      .where(eq(sources.id, context.source.id));
  }

  if (!primaryMaterial) {
    throw new Error("The source material could not be prepared.");
  }
  const existing = await existingArtifact(runId, "chunk_plan", "primary");
  if (existing) {
    const chunks = Array.isArray(existing.payload.chunks)
      ? (existing.payload.chunks as Array<{ key?: unknown }>).flatMap((item) =>
          typeof item.key === "string" ? [item.key] : [],
        )
      : [];
    return { cancelled: false, chunkKeys: chunks, reuseManifestFromRunId: null };
  }
  const ranges = chunkText(primaryMaterial.bodyText);
  const chunks = ranges.map((range, index) => ({
    key: `chunk-${index + 1}`,
    materialId: primaryMaterial.id,
    start: range.start,
    end: range.end,
  }));
  const residuals =
    primaryMaterial.bodyText.length > MAX_SOURCE_CHARS
      ? [
          `${(primaryMaterial.bodyText.length - MAX_SOURCE_CHARS).toLocaleString("en-US")} characters exceeded the bounded analysis window.`,
        ]
      : [];
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "chunk_plan",
    key: "primary",
    payload: { chunks, residuals },
  });
  await updateRunStage(runId, "mapping", "Mapping mastery", 18);
  return {
    cancelled: false,
    chunkKeys: chunks.map((chunk) => chunk.key),
    reuseManifestFromRunId: null,
  };
}

export async function reuseGenerationManifestStep(
  runId: string,
  sourceRunId: string,
): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  const context = await runContext(runId);
  const [sourceRun] = await getV2Db()
    .select({ manifest: generationRuns.manifest })
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.userId, context.run.userId),
        eq(generationRuns.id, sourceRunId),
      ),
    )
    .limit(1);
  if (!sourceRun?.manifest) {
    throw new Error("The cached mastery manifest is unavailable.");
  }
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "critic",
    key: "manifest",
    payload: sourceRun.manifest,
  });
  await getV2Db()
    .update(generationRuns)
    .set({
      manifest: sourceRun.manifest,
      status: "matching",
      stage: "Matching your question bank",
      progress: 58,
      updatedAt: new Date(),
    })
    .where(eq(generationRuns.id, runId));
}

export async function mapGenerationChunkStep(
  runId: string,
  chunkKey: string,
): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  if (await existingArtifact(runId, "map", chunkKey)) {
    return;
  }
  const context = await runContext(runId);
  const plan = await existingArtifact(runId, "chunk_plan", "primary");
  const chunks = Array.isArray(plan?.payload.chunks)
    ? (plan.payload.chunks as Array<Record<string, unknown>>)
    : [];
  const chunk = chunks.find((item) => item.key === chunkKey);
  if (!chunk) {
    throw new Error("The source chunk plan is incomplete.");
  }
  const materialId =
    typeof chunk.materialId === "string" ? chunk.materialId : "";
  const start = typeof chunk.start === "number" ? chunk.start : 0;
  const end = typeof chunk.end === "number" ? chunk.end : 0;
  const [material] = await getV2Db()
    .select()
    .from(sourceMaterials)
    .where(
      and(
        eq(sourceMaterials.userId, context.run.userId),
        eq(sourceMaterials.id, materialId),
        eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
      ),
    )
    .limit(1);
  if (!material || end <= start) {
    throw new Error("The source chunk material is unavailable.");
  }
  const result = await mapMasteryChunk({
    userId: context.run.userId,
    sourceTitle: context.source.title,
    materialId: material.id,
    materialTitle: material.title,
    chunkIndex: Math.max(0, chunks.indexOf(chunk)),
    chunkCount: chunks.length,
    text: material.bodyText.slice(start, end),
    maxTargets: Math.max(
      8,
      Math.ceil(SOURCE_GENERATION_BUDGET.maxTargets / chunks.length),
    ),
  });
  const targets = result.targets.map((target) => ({
    ...target,
    key: recallTargetKey(target.statement),
  }));
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "map",
    key: chunkKey,
    payload: { targets, unresolved: result.unresolved },
    usage: result.usage,
  });
  const mappedCount = await getV2Db()
    .select({ count: sql<number>`count(*)::int` })
    .from(generationRunArtifacts)
    .where(
      and(
        eq(generationRunArtifacts.generationRunId, runId),
        eq(generationRunArtifacts.kind, "map"),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));
  await updateRunStage(
    runId,
    "mapping",
    `Mapping mastery (${mappedCount}/${chunks.length})`,
    18 + Math.round((mappedCount / Math.max(1, chunks.length)) * 30),
  );
}

export async function critiqueGenerationRunStep(runId: string): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  if (await existingArtifact(runId, "critic", "manifest")) {
    return;
  }
  const context = await runContext(runId);
  await updateRunStage(runId, "criticizing", "Curating the minimum set", 50);
  const artifacts = await getV2Db()
    .select({ payload: generationRunArtifacts.payload })
    .from(generationRunArtifacts)
    .where(
      and(
        eq(generationRunArtifacts.generationRunId, runId),
        eq(generationRunArtifacts.kind, "map"),
      ),
    );
  const targetByKey = new Map<string, MasteryTargetDraft>();
  const unresolved: string[] = [];
  for (const artifact of artifacts) {
    if (Array.isArray(artifact.payload.targets)) {
      for (const raw of artifact.payload.targets as MasteryTargetDraft[]) {
        const target = { ...raw, key: recallTargetKey(raw.statement) };
        const previous = targetByKey.get(target.key);
        if (!previous || target.confidence > previous.confidence) {
          targetByKey.set(target.key, target);
        }
      }
    }
    if (Array.isArray(artifact.payload.unresolved)) {
      unresolved.push(
        ...(artifact.payload.unresolved as unknown[]).filter(
          (value): value is string => typeof value === "string",
        ),
      );
    }
  }
  const plan = await existingArtifact(runId, "chunk_plan", "primary");
  if (Array.isArray(plan?.payload.residuals)) {
    unresolved.push(
      ...(plan.payload.residuals as unknown[]).filter(
        (value): value is string => typeof value === "string",
      ),
    );
  }
  const initialTargets = [...targetByKey.values()].slice(
    0,
    SOURCE_GENERATION_BUDGET.maxTargets,
  );
  if (initialTargets.length === 0) {
    await writeArtifact({
      userId: context.run.userId,
      runId,
      kind: "critic",
      key: "manifest",
      payload: {
        targets: [],
        unresolved: [
          ...unresolved,
          "No defensible mastery targets were produced from this source.",
        ],
      },
    });
    return;
  }
  const result = await critiqueMasteryManifest({
    userId: context.run.userId,
    sourceTitle: context.source.title,
    targets: initialTargets,
    unresolved,
    maxTargets: SOURCE_GENERATION_BUDGET.maxTargets,
    minimumRequiredTargets: Math.min(
      16,
      initialTargets.filter((target) => target.requirement === "required").length,
    ),
  });
  const curated = [...new Map(
    result.targets.map((target) => {
      const normalized = { ...target, key: recallTargetKey(target.statement) };
      return [normalized.key, normalized] as const;
    }),
  ).values()].slice(0, SOURCE_GENERATION_BUDGET.maxTargets);
  const manifest = {
    targets: curated,
    unresolved: [...new Set(result.unresolved)].slice(0, 120),
  };
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "critic",
    key: "manifest",
    payload: manifest,
    usage: result.usage,
  });
  await getV2Db()
    .update(generationRuns)
    .set({
      manifest,
      status: "matching",
      stage: "Matching your question bank",
      progress: 58,
      usage: await totalUsage(runId),
      updatedAt: new Date(),
    })
    .where(eq(generationRuns.id, runId));
}

type BankQuestion = {
  id: string;
  versionId: string;
  prompt: string;
  target: string;
  referenceAnswer: string;
  lifecycle: string;
  latestGrade: string | null;
  dueAt: Date | null;
};

function isActiveQuestion(lifecycle: string): boolean {
  return (ACTIVE_QUESTION_LIFECYCLES as readonly string[]).includes(lifecycle);
}

export async function matchGenerationRunStep(runId: string): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  if (await existingArtifact(runId, "match", "plan")) {
    return;
  }
  const context = await runContext(runId);
  await updateRunStage(runId, "matching", "Matching your question bank", 62);
  const manifest = await existingArtifact(runId, "critic", "manifest");
  const targets = Array.isArray(manifest?.payload.targets)
    ? (manifest.payload.targets as MasteryTargetDraft[])
    : [];
  const pool = getV2Client().pool;
  const exact =
    targets.length > 0
      ? await pool.query<BankQuestion & { target_key: string }>(
          `SELECT q.id,
                  qv.id AS "versionId",
                  qv.prompt,
                  qv.target_text AS target,
                  qv.reference_answer AS "referenceAnswer",
                  q.lifecycle,
                  ms.due_at AS "dueAt",
                  latest_grade.value AS "latestGrade",
                  q.target_key
             FROM waxon_v2.questions q
             JOIN waxon_v2.question_versions qv
               ON qv.user_id = q.user_id AND qv.question_id = q.id AND qv.is_current = true
             LEFT JOIN waxon_v2.memory_states ms
               ON ms.user_id = q.user_id AND ms.question_id = q.id
             LEFT JOIN LATERAL (
               SELECT ge.grade AS value
                 FROM waxon_v2.answer_submissions a
                 JOIN waxon_v2.grade_events ge
                   ON ge.user_id = a.user_id AND ge.submission_id = a.id
                WHERE a.user_id = q.user_id AND a.question_id = q.id
                ORDER BY ge.created_at DESC
                LIMIT 1
             ) latest_grade ON true
            WHERE q.user_id = $1 AND q.target_key = ANY($2::text[])
            ORDER BY CASE WHEN q.lifecycle IN ('new','learning','review') THEN 0 ELSE 1 END,
                     q.updated_at DESC`,
          [context.run.userId, targets.map((target) => target.key)],
        )
      : { rows: [] as Array<BankQuestion & { target_key: string }> };
  const exactByTarget = new Map<string, BankQuestion>();
  for (const row of exact.rows) {
    if (!exactByTarget.has(row.target_key)) {
      exactByTarget.set(row.target_key, row);
    }
  }

  const unmatched = targets.filter((target) => !exactByTarget.has(target.key));
  const candidateIdsByTarget = new Map<string, string[]>();
  const questionById = new Map<string, BankQuestion>();
  let embeddingUsage = { ...EMPTY_GENERATION_USAGE };
  if (unmatched.length > 0) {
    const embedded = await embedTexts({
      userId: context.run.userId,
      texts: unmatched.map((target) => target.statement),
    });
    embeddingUsage = {
      ...EMPTY_GENERATION_USAGE,
      modelCalls: 1,
      inputTokens: Math.ceil(
        unmatched.reduce((sum, target) => sum + target.statement.length, 0) / 4,
      ),
    };
    const uniqueCandidates = new Set<string>();
    for (const [index, target] of unmatched.entries()) {
      const nearest = await pool.query<BankQuestion & { similarity: string | number }>(
        `SELECT q.id,
                qv.id AS "versionId",
                qv.prompt,
                qv.target_text AS target,
                qv.reference_answer AS "referenceAnswer",
                q.lifecycle,
                ms.due_at AS "dueAt",
                latest_grade.value AS "latestGrade",
                1 - (qe.embedding <=> $1::vector) AS similarity
           FROM waxon_v2.question_embeddings qe
           JOIN waxon_v2.question_versions qv
             ON qv.user_id = qe.user_id AND qv.id = qe.question_version_id AND qv.is_current = true
           JOIN waxon_v2.questions q
             ON q.user_id = qv.user_id AND q.id = qv.question_id
           LEFT JOIN waxon_v2.memory_states ms
             ON ms.user_id = q.user_id AND ms.question_id = q.id
           LEFT JOIN LATERAL (
             SELECT ge.grade AS value
               FROM waxon_v2.answer_submissions a
               JOIN waxon_v2.grade_events ge
                 ON ge.user_id = a.user_id AND ge.submission_id = a.id
              WHERE a.user_id = q.user_id AND a.question_id = q.id
              ORDER BY ge.created_at DESC
              LIMIT 1
           ) latest_grade ON true
          WHERE q.user_id = $2
            AND qe.model = $3
            AND 1 - (qe.embedding <=> $1::vector) >= 0.78
          ORDER BY qe.embedding <=> $1::vector
          LIMIT 8`,
        [vectorLiteral(embedded.embeddings[index]), context.run.userId, embedded.model],
      );
      const ids: string[] = [];
      for (const candidate of nearest.rows) {
        if (!uniqueCandidates.has(candidate.id) && uniqueCandidates.size >= 100) {
          continue;
        }
        uniqueCandidates.add(candidate.id);
        questionById.set(candidate.id, candidate);
        ids.push(candidate.id);
      }
      candidateIdsByTarget.set(target.key, ids);
    }
  }

  const judgeTargets = unmatched
    .filter((target) => (candidateIdsByTarget.get(target.key)?.length ?? 0) > 0)
    .map((target) => ({
      key: target.key,
      statement: target.statement,
      candidateQuestionIds: candidateIdsByTarget.get(target.key) ?? [],
    }));
  const judged = await judgeExistingCoverage({
    userId: context.run.userId,
    targets: judgeTargets,
    questions: [...questionById.values()].map((question) => ({
      id: question.id,
      prompt: question.prompt,
      target: question.target,
      referenceAnswer: question.referenceAnswer,
      lifecycle: question.lifecycle,
    })),
  });
  const decisionByTarget = new Map(
    judged.decisions.map((decision) => [decision.targetKey, decision]),
  );
  const matchPlan: MatchPlanItem[] = targets.map((target) => {
    const exactQuestion = exactByTarget.get(target.key);
    if (exactQuestion) {
      return {
        target,
        action: isActiveQuestion(exactQuestion.lifecycle) ? "reuse" : "inactive",
        questionId: exactQuestion.id,
        reason: "The bank contains the same canonical recall target.",
      };
    }
    const candidates = candidateIdsByTarget.get(target.key) ?? [];
    if (candidates.length === 0) {
      return {
        target,
        action: "generate",
        questionId: null,
        reason: "No sufficiently similar bank question was found.",
      };
    }
    const decision = decisionByTarget.get(target.key);
    if (!decision || decision.decision === "uncertain") {
      return {
        target,
        action: "uncertain",
        questionId: decision?.questionId ?? candidates[0] ?? null,
        reason: decision?.reason || "Possible overlap needs learner attention.",
      };
    }
    if (decision.decision === "equivalent" && decision.questionId) {
      const question = questionById.get(decision.questionId);
      return {
        target,
        action: question && isActiveQuestion(question.lifecycle) ? "reuse" : "inactive",
        questionId: decision.questionId,
        reason: decision.reason,
      };
    }
    return {
      target,
      action: "generate",
      questionId: null,
      reason: decision.reason,
    };
  });
  const fingerprint = sha256(
    JSON.stringify(
      [...exact.rows, ...questionById.values()]
        .map((question) => [question.id, question.versionId, question.lifecycle])
        .sort(),
    ),
  );
  const combinedUsage = {
    modelCalls: embeddingUsage.modelCalls + judged.usage.modelCalls,
    inputTokens: embeddingUsage.inputTokens + judged.usage.inputTokens,
    outputTokens: embeddingUsage.outputTokens + judged.usage.outputTokens,
    totalTokens: embeddingUsage.totalTokens + judged.usage.totalTokens,
    cost: embeddingUsage.cost + judged.usage.cost,
    webSearches: embeddingUsage.webSearches + judged.usage.webSearches,
  };
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "match",
    key: "plan",
    payload: { items: matchPlan, bankFingerprint: fingerprint },
    usage: combinedUsage,
  });
  await getV2Db()
    .update(generationRuns)
    .set({
      bankFingerprint: fingerprint,
      status: "drafting",
      stage: "Preparing questions",
      progress: 72,
      usage: await totalUsage(runId),
      updatedAt: new Date(),
    })
    .where(eq(generationRuns.id, runId));
}

function combineGenerationUsage(
  left: GenerationUsage,
  right: GenerationUsage,
): GenerationUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
    webSearches: left.webSearches + right.webSearches,
  };
}

export async function sequenceGenerationRunStep(
  runId: string,
  options?: { preserveRunStatus?: boolean },
): Promise<void> {
  if (await markCancelled(runId)) return;
  if (await existingArtifact(runId, "sequence", "path")) return;
  const context = await runContext(runId);
  if (!options?.preserveRunStatus) {
    await updateRunStage(runId, "drafting", "Sequencing the learning path", 78);
  }
  const match = await existingArtifact(runId, "match", "plan");
  const items = Array.isArray(match?.payload.items)
    ? (match.payload.items as MatchPlanItem[])
    : [];
  const requiredItems = items.filter(
    (item) => item.target.requirement === "required",
  );
  const materials = await getV2Db()
    .select({
      id: sourceMaterials.id,
      bodyText: sourceMaterials.bodyText,
      createdAt: sourceMaterials.createdAt,
    })
    .from(sourceMaterials)
    .where(
      and(
        eq(sourceMaterials.userId, context.run.userId),
        eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
      ),
    )
    .orderBy(asc(sourceMaterials.createdAt), asc(sourceMaterials.id));
  let cumulativeOffset = 0;
  const materialOffset = new Map<string, number>();
  for (const material of materials) {
    materialOffset.set(material.id, cumulativeOffset);
    cumulativeOffset += material.bodyText.length + 1;
  }
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const chunkPlan = await existingArtifact(runId, "chunk_plan", "primary");
  const chunks = Array.isArray(chunkPlan?.payload.chunks)
    ? (chunkPlan.payload.chunks as Array<Record<string, unknown>>)
    : [];
  const chunkByKey = new Map(
    chunks.flatMap((chunk) =>
      typeof chunk.key === "string" ? [[chunk.key, chunk] as const] : [],
    ),
  );
  const mapArtifacts = await getV2Db()
    .select({
      key: generationRunArtifacts.artifactKey,
      payload: generationRunArtifacts.payload,
    })
    .from(generationRunArtifacts)
    .where(
      and(
        eq(generationRunArtifacts.generationRunId, runId),
        eq(generationRunArtifacts.kind, "map"),
      ),
    );
  const chunkKeyByTarget = new Map<string, string>();
  for (const artifact of mapArtifacts) {
    if (!Array.isArray(artifact.payload.targets)) continue;
    for (const raw of artifact.payload.targets as Array<Record<string, unknown>>) {
      if (typeof raw.key === "string") chunkKeyByTarget.set(raw.key, artifact.key);
    }
  }
  const evidenceOffsets: Record<string, number> = {};
  const targets: SequenceTarget[] = requiredItems.map((item, index) => {
    const target = item.target;
    const material = materialById.get(target.evidenceMaterialId);
    const chunk = chunkByKey.get(chunkKeyByTarget.get(target.key) ?? "");
    const chunkStart = typeof chunk?.start === "number" ? chunk.start : 0;
    const chunkEnd = typeof chunk?.end === "number"
      ? chunk.end
      : material?.bodyText.length ?? 0;
    const localOffset = material
      ? material.bodyText.slice(chunkStart, chunkEnd).indexOf(target.evidenceQuote)
      : -1;
    const offset = localOffset >= 0
      ? chunkStart + localOffset
      : material?.bodyText.indexOf(target.evidenceQuote) ?? -1;
    const safeOffset = Math.max(0, offset);
    evidenceOffsets[target.key] = safeOffset;
    return {
      key: target.key,
      statement: target.statement,
      sourcePosition:
        (materialOffset.get(target.evidenceMaterialId) ?? cumulativeOffset + index) + safeOffset,
    };
  });
  const questionIds = [
    ...new Set(requiredItems.flatMap((item) => item.questionId ? [item.questionId] : [])),
  ];
  const matchedRows = questionIds.length > 0
    ? await getV2Client().pool.query<{
        id: string;
        prompt: string;
        lifecycle: string;
        latest_grade: string | null;
      }>(
        `SELECT q.id, qv.prompt, q.lifecycle,
                (SELECT ge.grade
                   FROM waxon_v2.answer_submissions a
                   JOIN waxon_v2.grade_events ge
                     ON ge.user_id = a.user_id AND ge.submission_id = a.id
                  WHERE a.user_id = q.user_id AND a.question_id = q.id
                  ORDER BY ge.created_at DESC, ge.id DESC LIMIT 1) AS latest_grade
           FROM waxon_v2.questions q
           JOIN waxon_v2.question_versions qv
             ON qv.user_id = q.user_id AND qv.question_id = q.id AND qv.is_current = true
          WHERE q.user_id = $1 AND q.id = ANY($2::uuid[])`,
        [context.run.userId, questionIds],
      ).then((result) => result.rows)
    : [];
  const matchedById = new Map(matchedRows.map((row) => [row.id, row]));
  const agentTargets = requiredItems.map((item) => {
    const position = targets.find((target) => target.key === item.target.key)!;
    const matched = item.questionId ? matchedById.get(item.questionId) : null;
    return {
      key: item.target.key,
      statement: item.target.statement,
      type: item.target.type,
      answerRubric: item.target.answerRubric,
      concepts: item.target.concepts,
      sourcePosition: position.sourcePosition,
      matchedQuestion: matched
        ? {
            id: matched.id,
            prompt: matched.prompt,
            lifecycle: matched.lifecycle,
            latestGrade: matched.latest_grade,
          }
        : null,
    };
  });
  let sequenceUsage = { ...EMPTY_GENERATION_USAGE };
  let draft: SequenceDraft | null = null;
  const priorUsage = await totalUsage(runId);
  if (priorUsage.modelCalls < SOURCE_GENERATION_BUDGET.modelCalls) {
    const first = await sequenceLearningPath({
      userId: context.run.userId,
      sourceTitle: context.source.title,
      targets: agentTargets,
    });
    draft = first.draft;
    sequenceUsage = first.usage;
  }
  let normalized = normalizeLearningPath({ targets, draft });
  if (
    normalized.status === "fallback_ready" &&
    draft &&
    priorUsage.modelCalls + sequenceUsage.modelCalls < SOURCE_GENERATION_BUDGET.modelCalls
  ) {
    const repaired = await sequenceLearningPath({
      userId: context.run.userId,
      sourceTitle: context.source.title,
      targets: agentTargets,
      initialDraft: draft,
      validationErrors: normalized.diagnostics,
    });
    sequenceUsage = combineGenerationUsage(sequenceUsage, repaired.usage);
    normalized = normalizeLearningPath({
      targets,
      draft: repaired.draft,
      diagnostics: repaired.draft
        ? []
        : ["The sequencing repair did not return a usable path."],
    });
  }
  const matchedQuestionByTarget = new Map(
    agentTargets.flatMap((target) =>
      target.matchedQuestion
        ? [[target.key, target.matchedQuestion.id] as const]
        : [],
    ),
  );
  normalized = {
    ...normalized,
    edges: removeSharedQuestionEdges(
      normalized.edges,
      matchedQuestionByTarget,
    ),
  };
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "sequence",
    key: "path",
    payload: { ...normalized, evidenceOffsets },
    usage: sequenceUsage,
  });
}

async function attachConcepts(
  tx: Parameters<Parameters<ReturnType<typeof getV2Db>["transaction"]>[0]>[0],
  input: { userId: string; questionId: string; names: string[] },
) {
  for (const rawName of input.names) {
    const name = rawName.trim().slice(0, 120);
    const slug = conceptSlug(name);
    if (!name || !slug) {
      continue;
    }
    const [concept] = await tx
      .insert(concepts)
      .values({ userId: input.userId, name, slug })
      .onConflictDoUpdate({
        target: [concepts.userId, concepts.slug],
        set: { name, updatedAt: new Date() },
      })
      .returning({ id: concepts.id });
    await tx
      .insert(questionConcepts)
      .values({
        userId: input.userId,
        questionId: input.questionId,
        conceptId: concept.id,
      })
      .onConflictDoNothing();
    await tx
      .insert(conceptAliases)
      .values({
        userId: input.userId,
        conceptId: concept.id,
        alias: name.toLocaleLowerCase("und"),
      })
      .onConflictDoNothing();
  }
}

export async function persistGenerationRunStep(runId: string): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  if (await existingArtifact(runId, "persist", "result")) {
    return;
  }
  const context = await runContext(runId);
  await updateRunStage(runId, "persisting", "Saving the curated set", 82);
  const match = await existingArtifact(runId, "match", "plan");
  const items = Array.isArray(match?.payload.items)
    ? (match.payload.items as MatchPlanItem[])
    : [];
  const manifest = await existingArtifact(runId, "critic", "manifest");
  const sequence = await existingArtifact(runId, "sequence", "path");
  const manifestResiduals = Array.isArray(manifest?.payload.unresolved)
    ? (manifest.payload.unresolved as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const materialIds = [
    ...new Set(items.map((item) => item.target.evidenceMaterialId).filter(Boolean)),
  ];
  const materials =
    materialIds.length > 0
      ? await getV2Db()
          .select()
          .from(sourceMaterials)
          .where(
            and(
              eq(sourceMaterials.userId, context.run.userId),
              eq(sourceMaterials.sourceRevisionId, context.run.sourceRevisionId),
              inArray(sourceMaterials.id, materialIds),
            ),
          )
      : [];
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const evidenceOffsets =
    sequence?.payload.evidenceOffsets &&
    typeof sequence.payload.evidenceOffsets === "object" &&
    !Array.isArray(sequence.payload.evidenceOffsets)
      ? (sequence.payload.evidenceOffsets as Record<string, unknown>)
      : {};

  const result = await getV2Db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`source-generation:${context.run.userId}`}))`,
    );
    const [lockedRun] = await tx
      .select({ status: generationRuns.status, cancelRequestedAt: generationRuns.cancelRequestedAt })
      .from(generationRuns)
      .where(eq(generationRuns.id, runId))
      .limit(1);
    if (!lockedRun || lockedRun.cancelRequestedAt || lockedRun.status === "cancelled") {
      return {
        ready: false,
        generated: [] as Array<{ questionId: string; versionId: string }>,
        residuals: ["Preparation was cancelled before persistence."],
        counts: { targets: items.length, reused: 0, generated: 0, attention: 1 },
      };
    }
    const [settings] = await tx
      .select({ autoAccept: learnerSettings.autoAcceptHighConfidence })
      .from(learnerSettings)
      .where(eq(learnerSettings.userId, context.run.userId))
      .limit(1);
    const autoAccept = settings?.autoAccept ?? true;
    const existingTargets = await tx
      .select()
      .from(coverageTargets)
      .where(
        and(
          eq(coverageTargets.userId, context.run.userId),
          eq(coverageTargets.sourceRevisionId, context.run.sourceRevisionId),
        ),
      );
    const targetByKey = new Map(
      existingTargets.flatMap((target) =>
        target.targetKey ? [[target.targetKey, target] as const] : [],
      ),
    );
    const incomingKeys = new Set(items.map((item) => item.target.key));
    for (const existing of existingTargets) {
      if (existing.targetKey && !incomingKeys.has(existing.targetKey)) {
        await tx
          .update(coverageTargets)
          .set({
            status: "ignored",
            requirement: "excluded",
            ignoreReason: "Removed by the latest curation pass.",
            updatedAt: new Date(),
          })
          .where(eq(coverageTargets.id, existing.id));
      }
    }

    const generated: Array<{ questionId: string; versionId: string }> = [];
    const pathTargetRows = new Map<
      string,
      { targetId: string; questionId: string | null; learnable: boolean }
    >();
    const residuals = [...manifestResiduals];
    let reusedCount = 0;
    let generatedCount = 0;
    let attentionCount = 0;

    for (const item of items) {
      const target = item.target;
      const material = materialById.get(target.evidenceMaterialId);
      const quote = target.evidenceQuote.trim();
      const plannedOffset = evidenceOffsets[target.key];
      const quoteOffset =
        typeof plannedOffset === "number" &&
        material?.bodyText.slice(plannedOffset, plannedOffset + quote.length) === quote
          ? plannedOffset
          : material?.bodyText.indexOf(quote) ?? -1;
      const supported = Boolean(material && quote && quoteOffset >= 0);
      const effectiveRequirement = supported
        ? target.requirement
        : "unsupported";
      const existingTarget = targetByKey.get(target.key);
      let targetId: string;
      if (existingTarget) {
        targetId = existingTarget.id;
        await tx
          .update(coverageTargets)
          .set({
            generationRunId: runId,
            targetType: target.type,
            statement: target.statement,
            answerRubric: target.answerRubric,
            requirement: effectiveRequirement,
            confidence: target.confidence,
            status:
              effectiveRequirement === "excluded" ? "ignored" : "unresolved",
            ignoreReason:
              effectiveRequirement === "excluded"
                ? "Excluded by the source mastery map."
                : null,
            updatedAt: new Date(),
          })
          .where(eq(coverageTargets.id, targetId));
      } else {
        const [created] = await tx
          .insert(coverageTargets)
          .values({
            userId: context.run.userId,
            sourceId: context.run.sourceId,
            sourceRevisionId: context.run.sourceRevisionId,
            generationRunId: runId,
            targetKey: target.key,
            targetType: target.type,
            statement: target.statement,
            answerRubric: target.answerRubric,
            requirement: effectiveRequirement,
            confidence: target.confidence,
            status:
              effectiveRequirement === "excluded" ? "ignored" : "unresolved",
            ignoreReason:
              effectiveRequirement === "excluded"
                ? "Excluded by the source mastery map."
                : null,
          })
          .returning({ id: coverageTargets.id });
        targetId = created.id;
      }
      pathTargetRows.set(target.key, {
        targetId,
        questionId: null,
        learnable: false,
      });
      await tx
        .delete(targetQuestions)
        .where(
          and(
            eq(targetQuestions.userId, context.run.userId),
            eq(targetQuestions.targetId, targetId),
          ),
        );

      if (effectiveRequirement === "excluded") {
        continue;
      }
      if (!supported || !material) {
        residuals.push(`Unsupported target: ${target.statement}`);
        attentionCount += 1;
        continue;
      }
      let evidenceId = await tx
        .select({ id: evidenceSpans.id })
        .from(evidenceSpans)
        .where(
          and(
            eq(evidenceSpans.userId, context.run.userId),
            eq(evidenceSpans.sourceVersionId, context.run.sourceRevisionId),
            eq(evidenceSpans.sourceMaterialId, material.id),
            eq(evidenceSpans.quote, quote),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.id ?? null);
      if (!evidenceId) {
        const [evidence] = await tx
          .insert(evidenceSpans)
          .values({
            userId: context.run.userId,
            sourceVersionId: context.run.sourceRevisionId,
            sourceMaterialId: material.id,
            section: target.type,
            startOffset: quoteOffset,
            endOffset: quoteOffset + quote.length,
            quote,
          })
          .returning({ id: evidenceSpans.id });
        evidenceId = evidence.id;
      }
      await tx
        .insert(targetEvidence)
        .values({
          userId: context.run.userId,
          targetId,
          evidenceSpanId: evidenceId,
        })
        .onConflictDoNothing();

      let questionId = item.questionId;
      let relation: string = item.action;
      if (item.action === "generate") {
        const [concurrentDuplicate] = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(
              eq(questions.userId, context.run.userId),
              eq(questions.targetKey, target.key),
              inArray(questions.lifecycle, [...ACTIVE_QUESTION_LIFECYCLES]),
            ),
          )
          .limit(1);
        if (concurrentDuplicate) {
          questionId = concurrentDuplicate.id;
          relation = "reuse";
        } else if (
          target.question &&
          target.answer &&
          target.answerMode
        ) {
          const quality = assessQuestionQuality({
            prompt: target.question,
            referenceAnswer: target.answer,
            target: target.statement,
          });
          const highConfidence = quality.passes && target.confidence >= 0.75;
          const shouldActivate = autoAccept && highConfidence;
          const [question] = await tx
            .insert(questions)
            .values({
              userId: context.run.userId,
              lifecycle: shouldActivate ? "new" : "draft",
              targetKey: target.key,
            })
            .returning({ id: questions.id });
          const [version] = await tx
            .insert(questionVersions)
            .values({
              userId: context.run.userId,
              questionId: question.id,
              version: 1,
              prompt: target.question,
              referenceAnswer: target.answer,
              displayAnswer: target.displayAnswer ?? target.answer.slice(0, 8_000),
              mode: target.answerMode,
              targetText: target.statement,
              quality: shouldActivate
                ? "distinct"
                : quality.passes
                  ? "uncertain"
                  : "rejected",
              qualityReasons: shouldActivate
                ? []
                : quality.passes
                  ? ["Generation confidence was below the automatic activation threshold."]
                  : quality.reasons,
            })
            .returning({ id: questionVersions.id });
          questionId = question.id;
          relation = "generated";
          generatedCount += 1;
          if (shouldActivate) {
            generated.push({ questionId: question.id, versionId: version.id });
          } else {
            attentionCount += 1;
            residuals.push(`Review generated question: ${target.statement}`);
          }
        } else {
          attentionCount += 1;
          residuals.push(`No safe question could be drafted for: ${target.statement}`);
        }
      }

      if (!questionId) {
        attentionCount += 1;
        residuals.push(`${item.reason}: ${target.statement}`);
        continue;
      }
      const [currentVersion] = await tx
        .select({
          id: questionVersions.id,
          lifecycle: questions.lifecycle,
          quality: questionVersions.quality,
        })
        .from(questionVersions)
        .innerJoin(
          questions,
          and(
            eq(questions.userId, questionVersions.userId),
            eq(questions.id, questionVersions.questionId),
          ),
        )
        .where(
          and(
            eq(questionVersions.userId, context.run.userId),
            eq(questionVersions.questionId, questionId),
            eq(questionVersions.isCurrent, true),
          ),
        )
        .limit(1);
      if (!currentVersion) {
        attentionCount += 1;
        residuals.push(`Matched question is unavailable: ${target.statement}`);
        continue;
      }
      await tx
        .insert(questionEvidence)
        .values([
          {
            userId: context.run.userId,
            questionVersionId: currentVersion.id,
            evidenceSpanId: evidenceId,
            requirement: "recall-target",
          },
          {
            userId: context.run.userId,
            questionVersionId: currentVersion.id,
            evidenceSpanId: evidenceId,
            requirement: "reference-answer",
          },
        ])
        .onConflictDoNothing();
      await tx
        .insert(targetQuestions)
        .values({
          userId: context.run.userId,
          targetId,
          questionId,
          relation,
        })
        .onConflictDoUpdate({
          target: [
            targetQuestions.userId,
            targetQuestions.targetId,
            targetQuestions.questionId,
          ],
          set: { relation },
        });
      const active = isActiveQuestion(currentVersion.lifecycle);
      pathTargetRows.set(target.key, {
        targetId,
        questionId,
        learnable: active && currentVersion.quality === "distinct",
      });
      await attachConcepts(tx, {
        userId: context.run.userId,
        questionId,
        names: target.concepts,
      });
      await tx
        .update(coverageTargets)
        .set({
          status: active ? "covered" : "weak",
          updatedAt: new Date(),
        })
        .where(eq(coverageTargets.id, targetId));
      if (relation === "reuse" && active) {
        reusedCount += 1;
      }
      if (!active) {
        attentionCount += 1;
        residuals.push(`Covered only by an inactive question: ${target.statement}`);
      }
    }

    const sequenceNodes = Array.isArray(sequence?.payload.nodes)
      ? (sequence.payload.nodes as Array<{
          key: string;
          kind: "target" | "external_prerequisite";
          targetKey: string | null;
          moduleTitle: string;
          modulePosition: number;
          statement: string;
          reason: string | null;
          sourcePosition: number;
          pedagogicalPosition: number;
        }>)
      : [];
    const sequenceEdges = Array.isArray(sequence?.payload.edges)
      ? (sequence.payload.edges as Array<{
          prerequisiteKey: string;
          dependentKey: string;
        }>)
      : [];
    const sequenceStatus =
      sequence?.payload.status === "ready" ||
      sequence?.payload.status === "fallback_ready"
        ? sequence.payload.status
        : "fallback_ready";
    const sequenceDiagnostics = Array.isArray(sequence?.payload.diagnostics)
      ? (sequence.payload.diagnostics as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : ["The learning-path artifact was unavailable during persistence."];
    await tx
      .update(sourceLearningPaths)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(sourceLearningPaths.userId, context.run.userId),
          eq(sourceLearningPaths.sourceId, context.run.sourceId),
          sql`${sourceLearningPaths.generationRunId} <> ${runId}`,
          sql`${sourceLearningPaths.status} <> 'superseded'`,
        ),
      );
    const missingPathTarget = sequenceNodes.length === 0 || sequenceNodes.some((node) => {
      if (node.kind !== "target" || !node.targetKey) return false;
      const linked = pathTargetRows.get(node.targetKey);
      return !linked?.targetId || !linked.questionId || !linked.learnable;
    });
    const pathStatus = missingPathTarget ? "needs_attention" : sequenceStatus;
    const [path] = await tx
      .insert(sourceLearningPaths)
      .values({
        userId: context.run.userId,
        sourceId: context.run.sourceId,
        sourceRevisionId: context.run.sourceRevisionId,
        generationRunId: runId,
        status: pathStatus,
        policyVersion: context.run.policyVersion,
        diagnostics: sequenceDiagnostics.slice(0, 40),
      })
      .onConflictDoUpdate({
        target: [
          sourceLearningPaths.userId,
          sourceLearningPaths.generationRunId,
        ],
        set: {
          status: pathStatus,
          policyVersion: context.run.policyVersion,
          diagnostics: sequenceDiagnostics.slice(0, 40),
          updatedAt: new Date(),
        },
      })
      .returning({ id: sourceLearningPaths.id });
    const nodeIdByKey = new Map<string, string>();
    for (const node of sequenceNodes) {
      const linked = node.targetKey ? pathTargetRows.get(node.targetKey) : null;
      const [created] = await tx
        .insert(sourceLearningNodes)
        .values({
          userId: context.run.userId,
          pathId: path.id,
          kind: node.kind,
          targetId: linked?.targetId ?? null,
          questionId: linked?.questionId ?? null,
          moduleTitle: node.moduleTitle,
          modulePosition: node.modulePosition,
          sourcePosition: node.sourcePosition,
          pedagogicalPosition: node.pedagogicalPosition,
          statement: node.statement,
          reason: node.reason,
        })
        .onConflictDoUpdate({
          target: [
            sourceLearningNodes.userId,
            sourceLearningNodes.pathId,
            sourceLearningNodes.pedagogicalPosition,
          ],
          set: {
            kind: node.kind,
            targetId: linked?.targetId ?? null,
            questionId: linked?.questionId ?? null,
            moduleTitle: node.moduleTitle,
            modulePosition: node.modulePosition,
            sourcePosition: node.sourcePosition,
            statement: node.statement,
            reason: node.reason,
            updatedAt: new Date(),
          },
        })
        .returning({ id: sourceLearningNodes.id });
      nodeIdByKey.set(node.key, created.id);
    }
    const edgeRows = sequenceEdges.flatMap((edge) => {
      const prerequisiteNodeId = nodeIdByKey.get(edge.prerequisiteKey);
      const dependentNodeId = nodeIdByKey.get(edge.dependentKey);
      return prerequisiteNodeId && dependentNodeId
        ? [{
            userId: context.run.userId,
            pathId: path.id,
            prerequisiteNodeId,
            dependentNodeId,
          }]
        : [];
    });
    if (edgeRows.length > 0) {
      await tx.insert(sourceLearningEdges).values(edgeRows).onConflictDoNothing();
    }
    await tx.execute(sql`
      UPDATE waxon_v2.source_learning_nodes n
         SET introduced_at = history.introduced_at,
             passed_at = history.passed_at,
             updated_at = now()
        FROM (
          SELECT candidate.id,
                 (SELECT min(rsi.exposed_at)
                    FROM waxon_v2.review_session_items rsi
                   WHERE rsi.user_id = candidate.user_id
                     AND rsi.question_id = candidate.question_id
                     AND rsi.exposed_at IS NOT NULL) AS introduced_at,
                 (SELECT min(a.submitted_at)
                    FROM waxon_v2.answer_submissions a
                    JOIN LATERAL (
                      SELECT ge.grade
                        FROM waxon_v2.grade_events ge
                       WHERE ge.user_id = a.user_id
                         AND ge.submission_id = a.id
                       ORDER BY ge.created_at DESC, ge.id DESC
                       LIMIT 1
                    ) effective ON true
                   WHERE a.user_id = candidate.user_id
                     AND a.question_id = candidate.question_id
                     AND a.status = 'graded'
                     AND effective.grade IN ('good', 'easy')) AS passed_at
            FROM waxon_v2.source_learning_nodes candidate
           WHERE candidate.user_id = ${context.run.userId}
             AND candidate.path_id = ${path.id}
             AND candidate.question_id IS NOT NULL
        ) history
       WHERE n.user_id = ${context.run.userId}
         AND n.id = history.id
    `);

    const uniqueResiduals = [...new Set(residuals)].slice(0, 200);
    const requiredUncovered = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(coverageTargets)
      .where(
        and(
          eq(coverageTargets.userId, context.run.userId),
          eq(coverageTargets.sourceRevisionId, context.run.sourceRevisionId),
          eq(coverageTargets.requirement, "required"),
          sql`${coverageTargets.status} <> 'covered'`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
    const ready = requiredUncovered === 0 && uniqueResiduals.length === 0;
    return {
      ready,
      generated,
      pathId: path.id,
      pathStatus,
      residuals: uniqueResiduals,
      counts: {
        targets: items.length,
        reused: reusedCount,
        generated: generatedCount,
        attention: attentionCount,
      },
    };
  });

  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "persist",
    key: "result",
    payload: result,
  });
  await updateRunStage(runId, "persisting", "Indexing new questions", 92);
}

export async function runLearningPathBackfillJob(jobId: string): Promise<void> {
  const job = await claimV2Job(jobId, "build_learning_path");
  if (!job) return;
  const runId = typeof job.payload.runId === "string" ? job.payload.runId : "";
  if (!runId) {
    await getV2Db()
      .update(jobs)
      .set({ status: "failed", error: "Generation run is required.", updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return;
  }
  try {
    const context = await runContext(runId);
    const [existing] = await getV2Db()
      .select({ id: sourceLearningPaths.id })
      .from(sourceLearningPaths)
      .where(
        and(
          eq(sourceLearningPaths.userId, job.userId),
          eq(sourceLearningPaths.generationRunId, runId),
        ),
      )
      .limit(1);
    if (!existing) {
      await sequenceGenerationRunStep(runId, { preserveRunStatus: true });
      const sequence = await existingArtifact(runId, "sequence", "path");
      const sequenceNodes = Array.isArray(sequence?.payload.nodes)
        ? (sequence.payload.nodes as Array<{
            key: string;
            kind: "target" | "external_prerequisite";
            targetKey: string | null;
            moduleTitle: string;
            modulePosition: number;
            statement: string;
            reason: string | null;
            sourcePosition: number;
            pedagogicalPosition: number;
          }>)
        : [];
      const sequenceEdges = Array.isArray(sequence?.payload.edges)
        ? (sequence.payload.edges as Array<{
            prerequisiteKey: string;
            dependentKey: string;
          }>)
        : [];
      const links = await getV2Client().pool.query<{
        target_key: string;
        target_id: string;
        question_id: string | null;
        learnable: boolean;
      }>(
        `SELECT DISTINCT ON (ct.target_key)
                ct.target_key, ct.id AS target_id, q.id AS question_id,
                (q.lifecycle IN ('new','learning','review') AND EXISTS (
                  SELECT 1 FROM waxon_v2.question_versions qv
                   WHERE qv.user_id = q.user_id
                     AND qv.question_id = q.id
                     AND qv.is_current = true
                     AND qv.quality_decision = 'distinct'
                )) AS learnable
           FROM waxon_v2.coverage_targets ct
           LEFT JOIN waxon_v2.target_questions tq
             ON tq.user_id = ct.user_id AND tq.target_id = ct.id
           LEFT JOIN waxon_v2.questions q
             ON q.user_id = tq.user_id AND q.id = tq.question_id
          WHERE ct.user_id = $1
            AND ct.source_revision_id = $2
            AND ct.target_key IS NOT NULL
          ORDER BY ct.target_key,
                   CASE WHEN q.lifecycle IN ('new','learning','review') THEN 0 ELSE 1 END,
                   q.updated_at DESC NULLS LAST`,
        [job.userId, context.run.sourceRevisionId],
      ).then((result) => result.rows);
      const linkByKey = new Map(links.map((link) => [link.target_key, link]));
      await getV2Db().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`path-backfill:${job.userId}:${runId}`}))`,
        );
        const [alreadyCreated] = await tx
          .select({ id: sourceLearningPaths.id })
          .from(sourceLearningPaths)
          .where(
            and(
              eq(sourceLearningPaths.userId, job.userId),
              eq(sourceLearningPaths.generationRunId, runId),
            ),
          )
          .limit(1);
        if (alreadyCreated) return;
        await tx
          .update(sourceLearningPaths)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(
            and(
              eq(sourceLearningPaths.userId, job.userId),
              eq(sourceLearningPaths.sourceId, context.run.sourceId),
              sql`${sourceLearningPaths.status} <> 'superseded'`,
            ),
          );
        const missing = sequenceNodes.length === 0 || sequenceNodes.some(
          (node) => {
            const link = node.targetKey ? linkByKey.get(node.targetKey) : null;
            return node.kind === "target" && (!link?.question_id || !link.learnable);
          },
        );
        const rawStatus = sequence?.payload.status;
        const [path] = await tx
          .insert(sourceLearningPaths)
          .values({
            userId: job.userId,
            sourceId: context.run.sourceId,
            sourceRevisionId: context.run.sourceRevisionId,
            generationRunId: runId,
            policyVersion: SOURCE_AGENT_POLICY_VERSION,
            status: missing
              ? "needs_attention"
              : rawStatus === "ready"
                ? "ready"
                : "fallback_ready",
            diagnostics: Array.isArray(sequence?.payload.diagnostics)
              ? (sequence.payload.diagnostics as string[]).slice(0, 40)
              : [],
          })
          .returning({ id: sourceLearningPaths.id });
        const nodeIdByKey = new Map<string, string>();
        for (const node of sequenceNodes) {
          const link = node.targetKey ? linkByKey.get(node.targetKey) : null;
          if (node.kind === "target" && !link) continue;
          const [created] = await tx
            .insert(sourceLearningNodes)
            .values({
              userId: job.userId,
              pathId: path.id,
              kind: node.kind,
              targetId: link?.target_id ?? null,
              questionId: link?.question_id ?? null,
              moduleTitle: node.moduleTitle,
              modulePosition: node.modulePosition,
              sourcePosition: node.sourcePosition,
              pedagogicalPosition: node.pedagogicalPosition,
              statement: node.statement,
              reason: node.reason,
            })
            .returning({ id: sourceLearningNodes.id });
          nodeIdByKey.set(node.key, created.id);
        }
        const edgeRows = sequenceEdges.flatMap((edge) => {
          const prerequisiteNodeId = nodeIdByKey.get(edge.prerequisiteKey);
          const dependentNodeId = nodeIdByKey.get(edge.dependentKey);
          return prerequisiteNodeId && dependentNodeId
            ? [{
                userId: job.userId,
                pathId: path.id,
                prerequisiteNodeId,
                dependentNodeId,
              }]
            : [];
        });
        if (edgeRows.length > 0) {
          await tx.insert(sourceLearningEdges).values(edgeRows).onConflictDoNothing();
        }
        await tx.execute(sql`
          UPDATE waxon_v2.source_learning_nodes n
             SET introduced_at = history.introduced_at,
                 passed_at = history.passed_at,
                 updated_at = now()
            FROM (
              SELECT candidate.id,
                     (SELECT min(rsi.exposed_at)
                        FROM waxon_v2.review_session_items rsi
                       WHERE rsi.user_id = candidate.user_id
                         AND rsi.question_id = candidate.question_id
                         AND rsi.exposed_at IS NOT NULL) AS introduced_at,
                     (SELECT min(a.submitted_at)
                        FROM waxon_v2.answer_submissions a
                        JOIN LATERAL (
                          SELECT ge.grade
                            FROM waxon_v2.grade_events ge
                           WHERE ge.user_id = a.user_id AND ge.submission_id = a.id
                           ORDER BY ge.created_at DESC, ge.id DESC LIMIT 1
                        ) effective ON true
                       WHERE a.user_id = candidate.user_id
                         AND a.question_id = candidate.question_id
                         AND a.status = 'graded'
                         AND effective.grade IN ('good','easy')) AS passed_at
                FROM waxon_v2.source_learning_nodes candidate
               WHERE candidate.user_id = ${job.userId} AND candidate.path_id = ${path.id}
            ) history
           WHERE n.user_id = ${job.userId} AND n.id = history.id
        `);
      });
    }
    await getV2Db()
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        result: { runId },
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    await getV2Db()
      .update(jobs)
      .set({
        status: job.attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + job.attempts * 30_000),
        lockedUntil: null,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    throw error;
  }
}

export async function indexGeneratedQuestionsStep(runId: string): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  if (await existingArtifact(runId, "index", "questions")) {
    return;
  }
  const context = await runContext(runId);
  const persisted = await existingArtifact(runId, "persist", "result");
  const generated = Array.isArray(persisted?.payload.generated)
    ? (persisted.payload.generated as Array<{
        questionId: string;
        versionId: string;
      }>)
    : [];
  if (generated.length === 0) {
    await writeArtifact({
      userId: context.run.userId,
      runId,
      kind: "index",
      key: "questions",
      payload: { indexed: 0 },
    });
    return;
  }
  const rows = await getV2Db()
    .select({
      versionId: questionVersions.id,
      prompt: questionVersions.prompt,
      answer: questionVersions.referenceAnswer,
    })
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.userId, context.run.userId),
        inArray(
          questionVersions.id,
          generated.map((item) => item.versionId),
        ),
      ),
    );
  const embedded = await embedTexts({
    userId: context.run.userId,
    texts: rows.map((row) => `${row.prompt}\n${row.answer}`),
  });
  await getV2Db().transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      await tx
        .insert(questionEmbeddings)
        .values({
          userId: context.run.userId,
          questionVersionId: row.versionId,
          model: embedded.model,
          embedding: embedded.embeddings[index],
        })
        .onConflictDoUpdate({
          target: [
            questionEmbeddings.userId,
            questionEmbeddings.questionVersionId,
            questionEmbeddings.model,
          ],
          set: { embedding: embedded.embeddings[index], createdAt: new Date() },
        });
    }
  });
  const estimatedInput = Math.ceil(
    rows.reduce((sum, row) => sum + row.prompt.length + row.answer.length, 0) / 4,
  );
  await writeArtifact({
    userId: context.run.userId,
    runId,
    kind: "index",
    key: "questions",
    payload: { indexed: rows.length },
    usage: {
      ...EMPTY_GENERATION_USAGE,
      modelCalls: 1,
      inputTokens: estimatedInput,
      totalTokens: estimatedInput,
    },
  });
  await updateRunStage(runId, "persisting", "Finishing", 97);
}

function budgetResiduals(usage: GenerationUsage): string[] {
  const residuals: string[] = [];
  if (usage.modelCalls > SOURCE_GENERATION_BUDGET.modelCalls) {
    residuals.push("The model-call budget was exhausted.");
  }
  if (usage.inputTokens > SOURCE_GENERATION_BUDGET.inputTokens) {
    residuals.push("The input-token budget was exhausted.");
  }
  if (usage.outputTokens > SOURCE_GENERATION_BUDGET.outputTokens) {
    residuals.push("The output-token budget was exhausted.");
  }
  if (usage.webSearches > SOURCE_GENERATION_BUDGET.webSearches) {
    residuals.push("The web-search budget was exhausted.");
  }
  return residuals;
}

export async function finalizeGenerationRunStep(runId: string): Promise<void> {
  if (await markCancelled(runId)) {
    return;
  }
  const context = await runContext(runId);
  const persisted = await existingArtifact(runId, "persist", "result");
  if (!persisted) {
    throw new Error("The generation result was not persisted.");
  }
  const usage = await totalUsage(runId);
  const residuals = [
    ...(Array.isArray(persisted.payload.residuals)
      ? (persisted.payload.residuals as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : []),
    ...budgetResiduals(usage),
  ];
  const wallClockSeconds = context.run.startedAt
    ? Math.round((Date.now() - context.run.startedAt.getTime()) / 1_000)
    : 0;
  if (wallClockSeconds > SOURCE_GENERATION_BUDGET.maxWallClockSeconds) {
    residuals.push("The generation run exceeded its wall-clock budget.");
  }
  const uniqueResiduals = [...new Set(residuals)].slice(0, 200);
  const ready = persisted.payload.ready === true && uniqueResiduals.length === 0;
  const status = ready ? "ready" : "needs_attention";
  await getV2Db().transaction(async (tx) => {
    await tx
      .update(generationRuns)
      .set({
        status,
        stage: ready ? "Question set ready" : "Needs attention",
        progress: 100,
        usage,
        result: {
          ...(persisted.payload as Record<string, unknown>),
          wallClockSeconds,
        },
        residuals: uniqueResiduals,
        error: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generationRuns.id, runId));
    await tx
      .update(sources)
      .set({
        status,
        processingProgress: 100,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sources.id, context.run.sourceId),
          eq(sources.activeRunId, runId),
        ),
      );
  });
}

export async function failGenerationRunStep(
  runId: string,
  message: string,
): Promise<void> {
  const context = await runContext(runId);
  if (
    context.run.status === "ready" ||
    context.run.status === "needs_attention" ||
    context.run.status === "cancelled"
  ) {
    return;
  }
  const error = message.slice(0, 2_000) || "Unknown generation error";
  await getV2Db().transaction(async (tx) => {
    await tx
      .update(generationRuns)
      .set({
        status: "failed",
        stage: "Failed",
        error,
        usage: await totalUsage(runId),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generationRuns.id, runId));
    await tx
      .update(sources)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(
        and(
          eq(sources.id, context.run.sourceId),
          eq(sources.activeRunId, runId),
        ),
      );
  });
}
