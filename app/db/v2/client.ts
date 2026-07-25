import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

function createV2Client() {
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required");
  }

  const pool = new Pool({ connectionString });

  return {
    pool,
    db: drizzle(pool, { schema }),
  };
}

type V2Client = ReturnType<typeof createV2Client>;
const globalForV2 = globalThis as typeof globalThis & {
  waxonV2Db?: V2Client;
};

export function getV2Client(): V2Client {
  if (!globalForV2.waxonV2Db) {
    globalForV2.waxonV2Db = createV2Client();
  }

  return globalForV2.waxonV2Db;
}

export function getV2Db() {
  return getV2Client().db;
}

