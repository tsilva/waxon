import { NextResponse } from "next/server";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";

export async function GET(request: Request) {
  const currentUser = await getCurrentUser({ fresh: true });

  if (!isAdminEmail(currentUser.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const all = await listLlmTraceInteractions({ includePayloads: false });
  const cursor = new URL(request.url).searchParams.get("cursor");
  const ordered = all.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  let remaining = ordered;
  if (cursor) {
    try {
      const [time, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
      if (typeof time !== "string" || typeof id !== "string") throw new Error();
      remaining = ordered.filter((entry) => entry.startedAt < time || (entry.startedAt === time && entry.id < id));
    } catch { return NextResponse.json({ error: "Invalid cursor." }, { status: 400 }); }
  }
  const interactions = remaining.slice(0, 50);
  const last = interactions.at(-1);
  const nextCursor = remaining.length > 50 && last
    ? Buffer.from(JSON.stringify([last.startedAt, last.id])).toString("base64url") : null;

  return NextResponse.json({
    interactions, nextCursor,
  });
}
