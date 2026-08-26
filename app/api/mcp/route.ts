import * as Sentry from "@sentry/nextjs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authorizeMcpRequest } from "@/app/lib/v2/mcpAuthorization";
import { startBackgroundJobs } from "@/app/lib/v2/backgroundJobRuntime";
import { waxonApplication } from "@/app/lib/v2/application";
import {
  toMcpAddResponse,
  toMcpCheckMatch,
  toMcpRankedQuestion,
  toMcpStoredQuestion,
} from "@/app/lib/v2/mcpContract";

export const runtime = "nodejs";

const lifecycleSchema = z.enum(["active", "flagged", "archived"]);
const flagOriginSchema = z.enum(["waxon_validation", "learner"]);
const flagSummarySchema = z.object({
  origin: flagOriginSchema,
  reasons: z.array(z.string()),
});
const flagSchema = flagSummarySchema.extend({
  detail: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

const questionSummarySchema = z.object({
  id: z.string(),
  prompt: z.string(),
  referenceAnswer: z.string(),
  lifecycle: lifecycleSchema,
  flags: z.array(flagSchema),
  updatedAt: z.string(),
  matchTypes: z
    .array(z.enum(["exact", "full_text", "trigram", "semantic"]))
    .optional(),
  exactPrompt: z.boolean().optional(),
  lexicalRank: z.number().int().nullable().optional(),
  semanticRank: z.number().int().nullable().optional(),
  combinedRank: z.number().int().optional(),
  trigramSimilarity: z.number().nullable().optional(),
  semanticSimilarity: z.number().nullable().optional(),
});

const searchModeSchema = z.enum(["lexical", "hybrid", "lexical_fallback"]);
const coverageSchema = z.object({
  exact: z.boolean(),
  lexical: z.boolean(),
  semantic: z.boolean(),
});
const searchMatchSchema = z.object({
  source: z.enum(["bank", "batch"]),
  id: z.string(),
  candidateId: z.string().nullable(),
  prompt: z.string(),
  referenceAnswer: z.string(),
  lifecycle: lifecycleSchema.nullable(),
  flags: z.array(flagSchema),
  updatedAt: z.string().nullable(),
  matchTypes: z.array(
    z.enum(["exact", "full_text", "trigram", "semantic"]),
  ),
  exactPrompt: z.boolean(),
  lexicalRank: z.number().int().nullable(),
  semanticRank: z.number().int().nullable(),
  combinedRank: z.number().int(),
  trigramSimilarity: z.number().nullable(),
  semanticSimilarity: z.number().nullable(),
});

const handler = createMcpHandler(
  ({ authInfo }) => {
    const userId = authInfo?.clientId;
    if (!userId) throw new Error("MCP authentication context is missing.");
    const application = waxonApplication.forAuthorizedMcpClient(userId);

    const server = new McpServer({ name: "waxon", version: "1.0.0" });
    server.registerTool(
      "search_questions",
      {
        title: "Search Waxon questions",
        description:
          "Find questions in the authenticated learner's bank using relevance-ranked text and, when enabled, semantic retrieval. Omit query to list recent questions. Use check_questions before adding questions.",
        inputSchema: z.object({
          query: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        outputSchema: z.object({
          questions: z.array(questionSummarySchema),
          searchMode: searchModeSchema.nullable(),
          coverage: coverageSchema.nullable(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, limit }) => {
        if (query?.trim()) {
          const checked = await application.questionBank.check({
            items: [
              {
                candidateId: "search-query",
                prompt: query,
                referenceAnswer: "",
              },
            ],
            limitPerItem: limit,
          });
          const result = checked.results[0];
          const output = {
            questions: result.matches
              .filter((match) => match.source === "bank")
              .map(toMcpRankedQuestion),
            searchMode: result.searchMode,
            coverage: result.coverage,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        const library = await application.questionBank.list({
          search: "",
          lifecycle: "all",
          limit,
        });
        const output = {
          questions: library.questions.map(toMcpStoredQuestion),
          searchMode: null,
          coverage: null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );

    server.registerTool(
      "check_questions",
      {
        title: "Check questions before adding",
        description:
          "Call before add_questions. A duplicate asks for the same recall target, not merely the same topic. Reuse, replace, or restore an exact or clearly equivalent existing Question. A related Question asking for a different fact, direction, condition, or explanation is distinct. Advice is read-only and semantic matches require your comparison.",
        inputSchema: z.object({
          items: z
            .array(
              z.object({
                candidateId: z.string().trim().min(1).max(200),
                prompt: z.string().trim().min(1).max(16_384),
                referenceAnswer: z.string().max(65_536),
              }),
            )
            .min(1)
            .max(50),
          limitPerItem: z.number().int().min(1).max(10).default(5),
        }),
        outputSchema: z.object({
          results: z.array(
            z.object({
              candidateId: z.string(),
              advisory: z.enum([
                "exact_duplicate",
                "review_similar",
                "no_close_match",
                "search_incomplete",
              ]),
              searchMode: searchModeSchema,
              coverage: coverageSchema,
              matches: z.array(searchMatchSchema),
            }),
          ),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ items, limitPerItem }) => {
        const checked = await application.questionBank.check({
          items,
          limitPerItem,
        });
        const output = {
          results: checked.results.map((result) => ({
            ...result,
            matches: result.matches.map(toMcpCheckMatch),
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
          "Atomically add up to 50 standalone questions to the authenticated learner's bank. Results distinguish Active creation, validation Flagging, idempotent replay, and exact duplicate retention. A duplicate with answerStandardConflict=true retains the existing Question identity and should be inspected or replaced deliberately. Call check_questions first and compare any review_similar matches by recall target; similarity never blocks add.",
        inputSchema: z.object({
          idempotencyKey: z.string().trim().min(1).max(200),
          items: z
            .array(
              z.object({
                prompt: z.string().max(16_384),
                referenceAnswer: z.string().max(65_536),
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
              outcome: z.enum([
                "created_active",
                "created_flagged",
                "idempotent_replay",
                "exact_duplicate",
              ]),
              lifecycle: lifecycleSchema,
              flags: z.array(flagSummarySchema),
              answerStandardConflict: z.boolean(),
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
        const added = await application.questionBank.add({
          idempotencyKey,
          items,
        });
        const output = toMcpAddResponse(added);
        try {
          await startBackgroundJobs(userId, 4);
        } catch (error) {
          Sentry.captureException(error, {
            tags: { surface: "mcp", stage: "start-question-embedding-jobs" },
          });
        }
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
  const authorization = await authorizeMcpRequest(request);
  if (!authorization.authorized) return authorization.response;
  const { userId } = authorization;
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
