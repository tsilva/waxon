import "server-only";
import { createRealtime } from "@neon/realtime/server";
import { reviewRealtimeQuery } from "./reviewRealtimeQueries";
import type { ReviewRealtimeBundle } from "./reviewRealtimeTypes";

export async function sealReviewRealtime(userId: string): Promise<ReviewRealtimeBundle> {
  const url = process.env.NEON_REALTIME_URL;
  const secret = process.env.NEON_REALTIME_SECRET;
  const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url || !secret || !connectionString) {
    throw new Error("Live updates are unavailable. Refresh the page to retrieve current Review data.");
  }
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "wss:") {
    throw new Error("Live updates are unavailable.");
  }
  const db = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!db) throw new Error("Live updates are unavailable.");
  const realtime = createRealtime({ secret, db });
  const query = await realtime.seal({ query: reviewRealtimeQuery(userId) });
  return { url, query };
}
