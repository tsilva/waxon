import * as Sentry from "@sentry/nextjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getV2Db } from "../../db/v2/client.ts";
import {
  jobs,
  questionSearchEmbeddings,
  questions,
} from "../../db/v2/schema.ts";
import {
  QUESTION_SEARCH_SOURCE_VERSION,
  questionSearchSourceHash,
  resolveQuestionSearchConfig,
} from "../../../shared/question-search.mts";
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
    const { model } = resolveQuestionSearchConfig();
    const existing = await db
      .select({
        questionId: questionSearchEmbeddings.questionId,
        sourceHash: questionSearchEmbeddings.sourceHash,
      })
      .from(questionSearchEmbeddings)
      .where(
        and(
          eq(questionSearchEmbeddings.userId, job.userId),
          eq(questionSearchEmbeddings.model, model),
          eq(
            questionSearchEmbeddings.sourceVersion,
            QUESTION_SEARCH_SOURCE_VERSION,
          ),
          inArray(questionSearchEmbeddings.questionId, questionIds),
        ),
      );
    const existingByQuestion = new Map(
      existing.map((row) => [row.questionId, row] as const),
    );
    const missing = current.filter((row) => {
      const prior = existingByQuestion.get(row.questionId);
      return (
        !prior ||
        prior.sourceHash !== questionSearchSourceHash(row.prompt)
      );
    });
    if (missing.length > 0) {
      const embedded = await embedQuestionSearchPrompts(
        job.userId,
        missing.map((row) => row.prompt),
      );
      await db
        .insert(questionSearchEmbeddings)
        .values(
          missing.map((row, index) => ({
            userId: job.userId,
            questionId: row.questionId,
            model: embedded.model,
            sourceVersion: QUESTION_SEARCH_SOURCE_VERSION,
            sourceHash: questionSearchSourceHash(row.prompt),
            embedding: embedded.embeddings[index] ?? [],
          })),
        )
        .onConflictDoUpdate({
          target: [
            questionSearchEmbeddings.userId,
            questionSearchEmbeddings.questionId,
            questionSearchEmbeddings.model,
            questionSearchEmbeddings.sourceVersion,
          ],
          set: {
            sourceHash: sql`excluded.source_hash`,
            embedding: sql`excluded.embedding`,
            updatedAt: new Date(),
          },
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
