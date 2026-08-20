import { createHash, randomBytes } from "node:crypto";

export const MCP_TOKEN_PREFIX = "waxon_mcp_";

export function hashMcpToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createMcpToken() {
  return `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}
