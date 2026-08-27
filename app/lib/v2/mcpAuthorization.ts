import { authenticateMcpBearer } from "./mcpCredentials.ts";

export type McpAuthorization =
  | { authorized: true; userId: string }
  | { authorized: false; response: Response };

export async function authorizeMcpRequest(
  request: Request,
): Promise<McpAuthorization> {
  const userId = await authenticateMcpBearer(request);
  if (userId) return { authorized: true, userId };
  return {
    authorized: false,
    response: new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="Waxon MCP"' },
    }),
  };
}
