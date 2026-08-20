import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

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
  waxonV2PgDb?: V2Client;
};

export function getV2Client(): V2Client {
  if (!globalForV2.waxonV2PgDb) {
    globalForV2.waxonV2PgDb = createV2Client();
  }

  return globalForV2.waxonV2PgDb;
}

export function getV2Db() {
  return getV2Client().db;
}
