import { defineConfig } from "drizzle-kit";

for (const envFile of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Missing env files are fine; CI can provide env vars directly.
  }
}

const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required");
}

export default defineConfig({
  schema: "./app/db/v2/schema.ts",
  out: "./drizzle-v2",
  dialect: "postgresql",
  schemaFilter: ["waxon_v2"],
  dbCredentials: {
    url: connectionString,
  },
});
