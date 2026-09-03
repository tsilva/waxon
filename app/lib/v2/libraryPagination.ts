type LibraryCursor = { updatedAt: string; id: string };

export function parseLibraryCursor(cursor: string | undefined): LibraryCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (
      Number.isNaN(new Date(updatedAt).getTime()) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        parsed.id,
      )
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt, id: parsed.id };
  } catch {
    throw new Error("The Library cursor is invalid.");
  }
}

export function libraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: cursor.updatedAt, id: cursor.id }),
  ).toString("base64url");
}
