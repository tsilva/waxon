import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

type DatabaseClient = {
  pool: Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const globalForDb = globalThis as typeof globalThis & {
  waxonDb?: DatabaseClient;
};

function createDatabaseClient(): DatabaseClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString });

  return {
    pool,
    db: drizzle(pool, { schema }),
  };
}

const databaseClient = globalForDb.waxonDb ?? createDatabaseClient();
globalForDb.waxonDb = databaseClient;

export const db = databaseClient.db;
export const pool = databaseClient.pool;
