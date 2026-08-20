import { and, eq, isNull } from "drizzle-orm";
import { getV2Db } from "@/app/db/v2/client";
import { mcpCredentials } from "@/app/db/v2/schema";
import {
  createMcpToken,
  hashMcpToken,
  MCP_TOKEN_PREFIX,
} from "./mcpToken";

export async function getMcpCredentialStatus(userId: string) {
  const db = getV2Db();
  const [credential] = await db
    .select({
      tokenPrefix: mcpCredentials.tokenPrefix,
      createdAt: mcpCredentials.createdAt,
      lastUsedAt: mcpCredentials.lastUsedAt,
      revokedAt: mcpCredentials.revokedAt,
    })
    .from(mcpCredentials)
    .where(eq(mcpCredentials.userId, userId))
    .limit(1);

  return credential
    ? {
        configured: true as const,
        active: credential.revokedAt === null,
        ...credential,
      }
    : { configured: false as const, active: false as const };
}

export async function rotateMcpCredential(userId: string) {
  const db = getV2Db();
  const token = createMcpToken();
  const now = new Date();
  const tokenPrefix = `${token.slice(0, MCP_TOKEN_PREFIX.length + 8)}…`;

  await db
    .insert(mcpCredentials)
    .values({
      userId,
      tokenHash: hashMcpToken(token),
      tokenPrefix,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: mcpCredentials.userId,
      set: {
        tokenHash: hashMcpToken(token),
        tokenPrefix,
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
      },
    });

  return { token, tokenPrefix, createdAt: now };
}

export async function revokeMcpCredential(userId: string) {
  const db = getV2Db();
  await db
    .update(mcpCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(mcpCredentials.userId, userId));
}

export async function authenticateMcpBearer(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token.startsWith(MCP_TOKEN_PREFIX) || token.length > 256) return null;

  const db = getV2Db();
  const [credential] = await db
    .select({ userId: mcpCredentials.userId })
    .from(mcpCredentials)
    .where(
      and(
        eq(mcpCredentials.tokenHash, hashMcpToken(token)),
        isNull(mcpCredentials.revokedAt),
      ),
    )
    .limit(1);
  if (!credential) return null;

  await db
    .update(mcpCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpCredentials.userId, credential.userId));
  return credential.userId;
}
