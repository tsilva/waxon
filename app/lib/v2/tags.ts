import { getV2Client } from "../../db/v2/client.ts";
import { activeEmbeddingSpace } from "./embeddingSpaces.ts";
import type { V2TagRef } from "./types.ts";

const TAG_PAGE_LIMIT = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TagCursor = { normalizedLabel: string; id: string };

function parseTagCursor(value: string | undefined): TagCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { normalizedLabel?: unknown; id?: unknown };
    if (
      typeof parsed.normalizedLabel !== "string" ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("invalid cursor");
    }
    return { normalizedLabel: parsed.normalizedLabel, id: parsed.id };
  } catch {
    throw new Error("The Tag cursor is invalid.");
  }
}

function tagCursor(cursor: TagCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function listTags(input: {
  userId: string;
  search?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ tags: V2TagRef[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(TAG_PAGE_LIMIT, input.limit ?? TAG_PAGE_LIMIT));
  const cursor = parseTagCursor(input.cursor);
  const search = input.search?.normalize("NFKC").trim().slice(0, 200) ?? "";
  const space = activeEmbeddingSpace();
  const result = await getV2Client().pool.query<{
    id: string;
    label: string;
    normalized_label: string;
  }>(
    `SELECT tag.id, tag.label, tag.normalized_label
       FROM waxon_v2.tags tag
       JOIN waxon_v2.tag_embeddings embedding
         ON embedding.user_id = tag.user_id
        AND embedding.tag_id = tag.id
        AND embedding.space_id = $2
      WHERE tag.user_id = $1
        AND tag.deleted_at IS NULL
        AND ($3 = '' OR tag.label ILIKE '%' || $3 || '%')
        AND (
          $4::text IS NULL
          OR (tag.normalized_label, tag.id) > ($4::text, $5::uuid)
        )
      ORDER BY tag.normalized_label, tag.id
      LIMIT $6`,
    [
      input.userId,
      space.id,
      search,
      cursor?.normalizedLabel ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    tags: page.map(({ id, label }) => ({ id, label })),
    nextCursor:
      result.rows.length > limit && last
        ? tagCursor({ normalizedLabel: last.normalized_label, id: last.id })
        : null,
  };
}
