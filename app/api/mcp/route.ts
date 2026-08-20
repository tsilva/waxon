import * as Sentry from "@sentry/nextjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authenticateMcpBearer } from "@/app/lib/v2/mcpCredentials";
import { addQuestions, listLibrary } from "@/app/lib/v2/service";

export const runtime = "nodejs";

const lifecycleSchema = z.enum([
  "new",
  "learning",
  "review",
  "paused",
  "archived",
  "trash",
]);

const questionSummarySchema = z.object({
  id: z.string(),
  prompt: z.string(),
  referenceAnswer: z.string(),
  lifecycle: lifecycleSchema,
  updatedAt: z.string(),
});

const handler = createMcpHandler(
  ({ authInfo }) => {
    const userId = authInfo?.clientId;
    if (!userId) throw new Error("MCP authentication context is missing.");

    const server = new McpServer({ name: "waxon", version: "1.0.0" });
    server.registerTool(
      "search_questions",
      {
        title: "Search Waxon questions",
        description:
          "Search the authenticated learner's question bank. Omit query to list recent questions.",
        inputSchema: z.object({
          query: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        outputSchema: z.object({ questions: z.array(questionSummarySchema) }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, limit }) => {
        const library = await listLibrary({
          userId,
          search: query ?? "",
          lifecycle: "all",
          limit,
        });
        const output = {
          questions: library.questions.map((question) => ({
            id: question.id,
            prompt: question.prompt,
            referenceAnswer: question.referenceAnswer,
            lifecycle: question.lifecycle,
            updatedAt: question.updatedAt,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "add_questions",
      {
        title: "Add Waxon questions",
        description:
          "Atomically add up to 50 standalone questions to the authenticated learner's bank.",
        inputSchema: z.object({
          idempotencyKey: z.string().trim().min(1).max(200),
          items: z
            .array(
              z.object({
                prompt: z.string().max(16_384),
                referenceAnswer: z.string().max(65_536),
                answerMode: z
                  .enum(["exact", "semantic", "rubric"])
                  .default("semantic"),
                importance: z.number().min(0.1).max(5).default(1),
              }),
            )
            .min(1)
            .max(50),
        }),
        outputSchema: z.object({
          results: z.array(
            z.object({
              id: z.string(),
              status: z.enum(["created", "existing"]),
              lifecycle: lifecycleSchema,
            }),
          ),
        }),
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ idempotencyKey, items }) => {
        const output = await addQuestions({
          userId,
          idempotencyKey,
          items,
          scope: "mcp",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );
    return server;
  },
  {
    legacy: "stateless",
    onerror(error) {
      Sentry.captureException(error, { tags: { surface: "mcp" } });
    },
  },
);

function requestOriginIsValid(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!host || host !== url.host) return false;
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

async function handleMcp(request: Request) {
  if (!requestOriginIsValid(request)) {
    return new Response("Forbidden", { status: 403 });
  }
  const userId = await authenticateMcpBearer(request);
  if (!userId) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="Waxon MCP"' },
    });
  }
  return handler.fetch(request, {
    authInfo: {
      token: "[validated personal token]",
      clientId: userId,
      scopes: ["questions:read", "questions:write"],
      resource: new URL(request.url),
    },
  });
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
