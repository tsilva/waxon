import * as Sentry from "@sentry/nextjs";
import { and, eq, inArray } from "drizzle-orm";
import { getV2Db } from "../../db/v2/client.ts";
import {
  jobs,
  questionEmbeddings,
  questions,
} from "../../db/v2/schema.ts";
import { resolveQuestionSearchConfig } from "../../../shared/question-search.mts";
import {
  activeEmbeddingSpace,
  validateEmbedding,
} from "./embeddingSpaces.ts";
import { claimV2Job } from "./jobs.ts";
import { embedQuestionSearchPrompts } from "./questionSearch.ts";

function jobQuestionIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.questionIds)) return [];
  return [
    ...new Set(
      payload.questionIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ].slice(0, 50);
}

export async function runQuestionEmbeddingJob(jobId: string): Promise<void> {
  const db = getV2Db();
  const job = await claimV2Job(jobId, "embed_question_batch");
  if (!job) return;
  const questionIds = jobQuestionIds(job.payload);
  try {
    if (questionIds.length === 0) {
      await db
        .update(jobs)
        .set({
          status: "cancelled",
          error: "Embedding job had no valid question IDs.",
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      return;
    }
    const current = await db
      .select({
        questionId: questions.id,
        prompt: questions.prompt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.userId, job.userId),
          inArray(questions.id, questionIds),
        ),
      );
    const space = activeEmbeddingSpace();
    const { model } = resolveQuestionSearchConfig();
    if (model !== space.requestModel) {
      throw new Error(`Embedding space ${space.key} requires ${space.requestModel}.`);
    }
    const existing = await db
      .select({
        questionId: questionEmbeddings.questionId,
      })
      .from(questionEmbeddings)
      .where(
        and(
          eq(questionEmbeddings.userId, job.userId),
          eq(questionEmbeddings.spaceId, space.id),
          inArray(questionEmbeddings.questionId, questionIds),
        ),
      );
    const existingQuestionIds = new Set(existing.map((row) => row.questionId));
    const missing = current.filter((row) => !existingQuestionIds.has(row.questionId));
    if (missing.length > 0) {
      const embedded = await embedQuestionSearchPrompts(
        job.userId,
        missing.map((row) => row.prompt),
      );
      if (embedded.model !== space.requestModel) {
        throw new Error(`Embedding provider returned ${embedded.model}, expected ${space.requestModel}.`);
      }
      await db
        .insert(questionEmbeddings)
        .values(
          missing.map((row, index) => ({
            userId: job.userId,
            spaceId: space.id,
            questionId: row.questionId,
            embedding: validateEmbedding(embedded.embeddings[index] ?? [], space),
          })),
        )
        .onConflictDoNothing({
          target: [
            questionEmbeddings.userId,
            questionEmbeddings.spaceId,
            questionEmbeddings.questionId,
          ],
        });
    }
    await db
      .update(jobs)
      .set({
        status: "succeeded",
        progress: 100,
        lockedUntil: null,
        result: {
          requested: questionIds.length,
          current: current.length,
          embedded: missing.length,
          skipped: current.length - missing.length,
        },
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = job.attempts;
    await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + attempts * 30_000),
        lockedUntil: null,
        error:
          error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    if (typeof Sentry.captureException === "function") {
      Sentry.captureException(error, {
        tags: { waxon_version: "lean", job_type: "embed_question_batch" },
        extra: { jobId: job.id },
      });
    }
    throw error;
  }
}
