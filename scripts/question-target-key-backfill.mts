import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";

const MIGRATION_NAME = "question-prompt-keys-v1";
const UPDATE_BATCH_SIZE = 500;
const ACTIVE_TARGET_LIFECYCLES = new Set(["active"]);

export type QuestionTargetKeyRow = {
  id: string;
  userId: string;
  lifecycle: string;
  targetKey: string;
  prompt: string;
  createdAt: Date;
};

export type QuestionTargetKeyUpdate = Pick<
  QuestionTargetKeyRow,
  "id" | "userId" | "lifecycle" | "targetKey"
>;

function duplicateTargetKey(desiredKey: string, questionId: string): string {
  return `duplicate:${desiredKey}:${questionId}`;
}

export function planQuestionTargetKeyUpdates(
  rows: readonly QuestionTargetKeyRow[],
): QuestionTargetKeyUpdate[] {
  const withDesiredKeys = rows.map((row) => ({
    ...row,
    desiredKey: questionPromptKey(row.prompt),
  }));
  const groups = new Map<string, typeof withDesiredKeys>();
  for (const row of withDesiredKeys) {
    const groupKey = JSON.stringify([row.userId, row.desiredKey]);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }

  const targetById = new Map<string, string>();
  for (const group of groups.values()) {
    const active = group
      .filter((row) => ACTIVE_TARGET_LIFECYCLES.has(row.lifecycle))
      .sort(
        (left, right) =>
          Number(right.targetKey === right.desiredKey) -
            Number(left.targetKey === left.desiredKey) ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      );
    const canonicalActiveId = active[0]?.id;
    for (const row of group) {
      targetById.set(
        row.id,
        ACTIVE_TARGET_LIFECYCLES.has(row.lifecycle) &&
          row.id !== canonicalActiveId
          ? duplicateTargetKey(row.desiredKey, row.id)
          : row.desiredKey,
      );
    }
  }

  return rows.flatMap((row) => {
    const targetKey = targetById.get(row.id);
    return targetKey && targetKey !== row.targetKey
      ? [{ id: row.id, userId: row.userId, lifecycle: row.lifecycle, targetKey }]
      : [];
  });
}

async function applyUpdates(
  client: PoolClient,
  updates: readonly QuestionTargetKeyUpdate[],
): Promise<number> {
  let updated = 0;
  for (let offset = 0; offset < updates.length; offset += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(offset, offset + UPDATE_BATCH_SIZE);
    const result = await client.query(
      `UPDATE waxon_v2.questions question
          SET target_key = input.target_key
         FROM jsonb_to_recordset($1::jsonb)
           AS input(id uuid, user_id text, target_key text)
        WHERE question.id = input.id
          AND question.user_id = input.user_id`,
      [JSON.stringify(batch.map((item) => ({
        id: item.id,
        user_id: item.userId,
        target_key: item.targetKey,
      })))],
    );
    updated += result.rowCount ?? 0;
  }
  return updated;
}

export async function backfillQuestionTargetKeys(pool: Pool): Promise<{
  status: "applied" | "already_applied";
  scanned: number;
  updated: number;
  activeDuplicatesPreserved: number;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`data-migration:${MIGRATION_NAME}`],
    );
    const marker = await client.query(
      `SELECT 1
         FROM waxon_v2.data_migration_markers
        WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (marker.rowCount) {
      await client.query("COMMIT");
      return {
        status: "already_applied",
        scanned: 0,
        updated: 0,
        activeDuplicatesPreserved: 0,
      };
    }

    const result = await client.query<{
      id: string;
      user_id: string;
      lifecycle: string;
      target_key: string;
      prompt: string;
      created_at: Date;
    }>(
      `SELECT question.id, question.user_id, question.lifecycle::text,
              question.target_key, question.prompt, question.created_at
         FROM waxon_v2.questions question
        ORDER BY question.user_id, question.created_at, question.id`,
    );
    const rows: QuestionTargetKeyRow[] = result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      lifecycle: row.lifecycle,
      targetKey: row.target_key,
      prompt: row.prompt,
      createdAt: row.created_at,
    }));
    const updates = planQuestionTargetKeyUpdates(rows);
    const temporaryUpdates = updates
      .filter((update) => ACTIVE_TARGET_LIFECYCLES.has(update.lifecycle))
      .map((update) => ({
        ...update,
        targetKey: `repair:${MIGRATION_NAME}:${update.id}`,
      }));
    await applyUpdates(client, temporaryUpdates);
    const updated = await applyUpdates(client, updates);
    await client.query(
      `INSERT INTO waxon_v2.data_migration_markers (name)
       VALUES ($1)`,
      [MIGRATION_NAME],
    );
    await client.query("COMMIT");
    return {
      status: "applied",
      scanned: rows.length,
      updated,
      activeDuplicatesPreserved: updates.filter((update) =>
        update.targetKey.startsWith("duplicate:"),
      ).length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required");
  }
  const pool = new Pool({ connectionString });
  try {
    console.info(JSON.stringify(await backfillQuestionTargetKeys(pool)));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
