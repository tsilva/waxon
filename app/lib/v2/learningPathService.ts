import { and, desc, eq, sql } from "drizzle-orm";
import { getV2Client, getV2Db } from "@/app/db/v2/client";
import {
  sourceFocusStack,
  sourceLearningNodes,
  sourceLearningPaths,
  sources,
} from "@/app/db/v2/schema";
import { createSourceGeneration } from "./sourceGeneration";
import { startSourceGeneration } from "./sourceGenerationRuntime";
import type { V2AnswerMode, V2Lifecycle } from "./types";

export type FocusedIntroduction = {
  hasFocus: boolean;
  blockedReason: string | null;
  questionId: string | null;
  questionVersionId: string | null;
  lifecycle: V2Lifecycle | null;
  answerMode: V2AnswerMode | null;
  importance: number;
  createdAt: Date | null;
  pathNodeIds: string[];
  sourceContext: {
    sourceId: string;
    sourceTitle: string;
    moduleTitle: string;
    checkpoint: number;
    checkpointTotal: number;
  } | null;
};

export async function getFocusedIntroduction(
  userId: string,
): Promise<FocusedIntroduction> {
  const pool = getV2Client().pool;
  const focus = await pool.query<{
    source_id: string;
    source_title: string;
    path_id: string;
  }>(
    `SELECT f.source_id, s.title AS source_title, f.path_id
       FROM waxon_v2.source_focus_stack f
       JOIN waxon_v2.sources s
         ON s.user_id = f.user_id AND s.id = f.source_id
      WHERE f.user_id = $1
      ORDER BY f.depth DESC
      LIMIT 1`,
    [userId],
  ).then((result) => result.rows[0] ?? null);
  if (!focus) {
    return {
      hasFocus: false,
      blockedReason: null,
      questionId: null,
      questionVersionId: null,
      lifecycle: null,
      answerMode: null,
      importance: 1,
      createdAt: null,
      pathNodeIds: [],
      sourceContext: null,
    };
  }
  const candidate = await pool.query<{
    node_id: string;
    question_id: string;
    question_version_id: string;
    lifecycle: V2Lifecycle;
    answer_mode: V2AnswerMode;
    importance: number | string;
    created_at: Date;
    module_title: string;
    checkpoint: string;
    checkpoint_total: string;
  }>(
    `SELECT n.id AS node_id,
            n.question_id,
            qv.id AS question_version_id,
            q.lifecycle,
            qv.answer_mode,
            q.importance,
            q.created_at,
            n.module_title,
            (SELECT count(*)::text FROM (
               SELECT checkpoint.question_id
                 FROM waxon_v2.source_learning_nodes checkpoint
                WHERE checkpoint.user_id = n.user_id
                  AND checkpoint.path_id = n.path_id
                  AND checkpoint.kind = 'target'
                  AND checkpoint.question_id IS NOT NULL
                GROUP BY checkpoint.question_id
               HAVING max(checkpoint.pedagogical_position) <= n.pedagogical_position
             ) ranked_checkpoints) AS checkpoint,
            (SELECT count(DISTINCT total.question_id)::text
               FROM waxon_v2.source_learning_nodes total
              WHERE total.user_id = n.user_id
                AND total.path_id = n.path_id
                AND total.kind = 'target'
                AND total.question_id IS NOT NULL) AS checkpoint_total
       FROM waxon_v2.source_learning_nodes n
       JOIN waxon_v2.questions q
         ON q.user_id = n.user_id AND q.id = n.question_id
       JOIN waxon_v2.question_versions qv
         ON qv.user_id = q.user_id AND qv.question_id = q.id AND qv.is_current = true
      WHERE n.user_id = $1
        AND n.path_id = $2
        AND n.kind = 'target'
        AND n.question_id IS NOT NULL
        AND n.pedagogical_position = (
          SELECT max(representative.pedagogical_position)
            FROM waxon_v2.source_learning_nodes representative
           WHERE representative.user_id = n.user_id
             AND representative.path_id = n.path_id
             AND representative.question_id = n.question_id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM waxon_v2.source_learning_nodes introduced
           WHERE introduced.user_id = n.user_id
             AND introduced.path_id = n.path_id
             AND introduced.question_id = n.question_id
             AND introduced.introduced_at IS NOT NULL
        )
        AND q.lifecycle = 'new'
        AND qv.quality_decision = 'distinct'
        AND NOT EXISTS (
          SELECT 1
            FROM waxon_v2.source_learning_edges edge
            JOIN waxon_v2.source_learning_nodes prerequisite
              ON prerequisite.user_id = edge.user_id
             AND prerequisite.id = edge.prerequisite_node_id
           WHERE edge.user_id = n.user_id
             AND edge.path_id = n.path_id
             AND edge.dependent_node_id IN (
               SELECT sibling.id
                 FROM waxon_v2.source_learning_nodes sibling
                WHERE sibling.user_id = n.user_id
                  AND sibling.path_id = n.path_id
                  AND sibling.question_id = n.question_id
             )
             AND prerequisite.question_id IS DISTINCT FROM n.question_id
             AND prerequisite.passed_at IS NULL
        )
      ORDER BY n.pedagogical_position, n.id
      LIMIT 1`,
    [userId, focus.path_id],
  ).then((result) => result.rows[0] ?? null);
  if (!candidate) {
    const blocker = await pool.query<{ statement: string; reason: string | null }>(
      `SELECT prerequisite.statement, prerequisite.reason
         FROM waxon_v2.source_learning_edges edge
         JOIN waxon_v2.source_learning_nodes dependent
           ON dependent.user_id = edge.user_id AND dependent.id = edge.dependent_node_id
         JOIN waxon_v2.source_learning_nodes prerequisite
           ON prerequisite.user_id = edge.user_id AND prerequisite.id = edge.prerequisite_node_id
        WHERE edge.user_id = $1
          AND edge.path_id = $2
          AND dependent.introduced_at IS NULL
          AND prerequisite.question_id IS DISTINCT FROM dependent.question_id
          AND prerequisite.passed_at IS NULL
        ORDER BY dependent.pedagogical_position, prerequisite.pedagogical_position
        LIMIT 1`,
      [userId, focus.path_id],
    ).then((result) => result.rows[0] ?? null);
    return {
      hasFocus: true,
      blockedReason: blocker
        ? blocker.reason || `Recall “${blocker.statement}” before continuing.`
        : "This source is waiting for an introduced prerequisite to become due again.",
      questionId: null,
      questionVersionId: null,
      lifecycle: null,
      answerMode: null,
      importance: 1,
      createdAt: null,
      pathNodeIds: [],
      sourceContext: null,
    };
  }
  const nodeIds = await pool.query<{ id: string }>(
    `SELECT id
       FROM waxon_v2.source_learning_nodes
      WHERE user_id = $1 AND path_id = $2 AND question_id = $3
      ORDER BY pedagogical_position`,
    [userId, focus.path_id, candidate.question_id],
  ).then((result) => result.rows.map((row) => row.id));
  return {
    hasFocus: true,
    blockedReason: null,
    questionId: candidate.question_id,
    questionVersionId: candidate.question_version_id,
    lifecycle: candidate.lifecycle,
    answerMode: candidate.answer_mode,
    importance: Number(candidate.importance),
    createdAt: candidate.created_at,
    pathNodeIds: nodeIds,
    sourceContext: {
      sourceId: focus.source_id,
      sourceTitle: focus.source_title,
      moduleTitle: candidate.module_title,
      checkpoint: Number(candidate.checkpoint),
      checkpointTotal: Number(candidate.checkpoint_total),
    },
  };
}

export async function focusSource(input: {
  userId: string;
  sourceId: string;
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`source-focus:${input.userId}`}))`,
    );
    const [selected] = await tx
      .select({
        sourceId: sources.id,
        status: sources.status,
        pathId: sourceLearningPaths.id,
      })
      .from(sources)
      .innerJoin(
        sourceLearningPaths,
        and(
          eq(sourceLearningPaths.userId, sources.userId),
          eq(sourceLearningPaths.sourceId, sources.id),
          eq(sourceLearningPaths.generationRunId, sources.activeRunId),
        ),
      )
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!selected || selected.status === "disabled") {
      throw new Error("This source does not have an available learning path.");
    }
    const chain: Array<{
      sourceId: string;
      pathId: string;
      parentGapNodeId: string | null;
    }> = [{
      sourceId: selected.sourceId,
      pathId: selected.pathId,
      parentGapNodeId: null,
    }];
    const seen = new Set([selected.sourceId]);
    let currentSourceId = selected.sourceId;
    for (let depth = 0; depth < 12; depth += 1) {
      const [parentGap] = await tx
        .select({
          id: sourceLearningNodes.id,
          pathId: sourceLearningNodes.pathId,
          parentSourceId: sourceLearningPaths.sourceId,
        })
        .from(sourceLearningNodes)
        .innerJoin(
          sourceLearningPaths,
          and(
            eq(sourceLearningPaths.userId, sourceLearningNodes.userId),
            eq(sourceLearningPaths.id, sourceLearningNodes.pathId),
          ),
        )
        .innerJoin(
          sources,
          and(
            eq(sources.userId, sourceLearningPaths.userId),
            eq(sources.id, sourceLearningPaths.sourceId),
            eq(sources.activeRunId, sourceLearningPaths.generationRunId),
          ),
        )
        .where(
          and(
            eq(sourceLearningNodes.userId, input.userId),
            eq(sourceLearningNodes.bridgeSourceId, currentSourceId),
            eq(sourceLearningNodes.kind, "external_prerequisite"),
            sql`${sourceLearningPaths.status} <> 'superseded'`,
            sql`${sources.status} <> 'disabled'`,
          ),
        )
        .orderBy(desc(sourceLearningNodes.createdAt))
        .limit(1);
      if (!parentGap) break;
      if (seen.has(parentGap.parentSourceId)) {
        throw new Error("The prerequisite path contains a source cycle.");
      }
      chain[0] = { ...chain[0], parentGapNodeId: parentGap.id };
      chain.unshift({
        sourceId: parentGap.parentSourceId,
        pathId: parentGap.pathId,
        parentGapNodeId: null,
      });
      seen.add(parentGap.parentSourceId);
      currentSourceId = parentGap.parentSourceId;
    }
    await tx.delete(sourceFocusStack).where(eq(sourceFocusStack.userId, input.userId));
    for (const [depth, item] of chain.entries()) {
      await tx.insert(sourceFocusStack).values({
        userId: input.userId,
        depth,
        sourceId: item.sourceId,
        pathId: item.pathId,
        parentGapNodeId: item.parentGapNodeId,
      });
    }
  });
}

export async function unfocusSource(userId: string): Promise<void> {
  await getV2Db()
    .delete(sourceFocusStack)
    .where(eq(sourceFocusStack.userId, userId));
}

export async function advanceCompletedFocus(userId: string): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`source-focus:${userId}`}))`,
    );
    for (let pass = 0; pass < 16; pass += 1) {
      const [focus] = await tx
        .select({
          depth: sourceFocusStack.depth,
          pathId: sourceFocusStack.pathId,
          parentGapNodeId: sourceFocusStack.parentGapNodeId,
        })
        .from(sourceFocusStack)
        .where(eq(sourceFocusStack.userId, userId))
        .orderBy(desc(sourceFocusStack.depth))
        .limit(1);
      if (!focus) return;
      const [remaining] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sourceLearningNodes)
        .where(
          and(
            eq(sourceLearningNodes.userId, userId),
            eq(sourceLearningNodes.pathId, focus.pathId),
            sql`${sourceLearningNodes.passedAt} IS NULL`,
          ),
        );
      if (Number(remaining?.count ?? 0) > 0) return;
      await tx
        .delete(sourceFocusStack)
        .where(
          and(
            eq(sourceFocusStack.userId, userId),
            eq(sourceFocusStack.depth, focus.depth),
          ),
        );
      if (focus.parentGapNodeId) {
        await tx
          .update(sourceLearningNodes)
          .set({ passedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(sourceLearningNodes.userId, userId),
              eq(sourceLearningNodes.id, focus.parentGapNodeId),
            ),
          );
      }
    }
  });
}

export async function buildPrerequisiteSource(input: {
  userId: string;
  sourceId: string;
  gapNodeId: string;
}) {
  const db = getV2Db();
  const client = await getV2Client().pool.connect();
  let created: Awaited<ReturnType<typeof createSourceGeneration>> | null = null;
  try {
    const lockKey = `prerequisite-source:${input.userId}:${input.gapNodeId}`;
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    const [gap] = await db
      .select({
        id: sourceLearningNodes.id,
        statement: sourceLearningNodes.statement,
        bridgeSourceId: sourceLearningNodes.bridgeSourceId,
        parentTitle: sources.title,
      })
      .from(sourceLearningNodes)
      .innerJoin(
        sourceLearningPaths,
        and(
          eq(sourceLearningPaths.userId, sourceLearningNodes.userId),
          eq(sourceLearningPaths.id, sourceLearningNodes.pathId),
        ),
      )
      .innerJoin(
        sources,
        and(
          eq(sources.userId, sourceLearningPaths.userId),
          eq(sources.id, sourceLearningPaths.sourceId),
        ),
      )
      .where(
        and(
          eq(sourceLearningNodes.userId, input.userId),
          eq(sourceLearningNodes.id, input.gapNodeId),
          eq(sourceLearningNodes.kind, "external_prerequisite"),
          eq(sourceLearningPaths.sourceId, input.sourceId),
        ),
      )
      .limit(1);
    if (!gap) throw new Error("Prerequisite gap not found.");
    if (gap.bridgeSourceId) {
      return { sourceId: gap.bridgeSourceId, reused: true };
    }
    created = await createSourceGeneration({
      userId: input.userId,
      kind: "topic",
      title: `Prerequisite: ${gap.statement}`.slice(0, 300),
      rawText:
        `Teach the minimum prerequisite knowledge needed for “${gap.statement}” before continuing “${gap.parentTitle}”. ` +
        "Build an atomic mastery question set that proves this prerequisite, without expanding into unrelated material.",
    });
    await db
      .update(sourceLearningNodes)
      .set({ bridgeSourceId: created.sourceId, updatedAt: new Date() })
      .where(
        and(
          eq(sourceLearningNodes.userId, input.userId),
          eq(sourceLearningNodes.id, gap.id),
          sql`${sourceLearningNodes.bridgeSourceId} IS NULL`,
        ),
      );
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [
        `prerequisite-source:${input.userId}:${input.gapNodeId}`,
      ])
      .catch(() => undefined);
    client.release();
  }
  if (!created) throw new Error("Prerequisite source could not be created.");
  const workflowRunId = await startSourceGeneration(created.runId);
  return { ...created, workflowRunId };
}
