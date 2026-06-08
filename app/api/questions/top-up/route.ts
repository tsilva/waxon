import { NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import {
  generateBulkQuestionsFromMemory,
  normalizeBulkQuestionCount,
} from "@/app/lib/bulkQuestionGeneration";
import { refreshDeckMemory } from "@/app/lib/deckMemory";
import {
  ensureQuestionsDatabase,
  listDecks,
} from "@/app/lib/postgresStore";
import { getOpenRouterChatConfig } from "@/app/lib/openRouter";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOP_UP_BODY_BYTES = 16 * 1024;

function encodeStreamEvent(event: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_TOP_UP_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const openRouterConfig = getOpenRouterChatConfig({
    requireConfiguredModel: true,
  });

  if (!openRouterConfig.ok) {
    return NextResponse.json(
      { ok: false, error: openRouterConfig.error },
      { status: 500 },
    );
  }

  const { apiKey, model } = openRouterConfig;

  const user = await getCurrentUser();
  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const count = normalizeBulkQuestionCount(payload.count);
  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "questions-top-up",
    rules: [
      { name: "minute", max: 3, windowMs: 60_000 },
      { name: "day", max: 80, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  await ensureQuestionsDatabase();

  const rotationDeck = (await listDecks({ userId: user.id })).find(
    (deck) => deck.inReviewRotation,
  );

  if (!rotationDeck) {
    return NextResponse.json(
      { ok: false, error: "No deck is in review rotation." },
      { status: 400 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encodeStreamEvent(event, data));
      };

      try {
        send("progress", {
          ok: true,
          phase: "memory",
          status: "Updating deck memory",
          progress: 8,
          generated: 0,
          total: count,
        });

        const memoryResult = await refreshDeckMemory({
          apiKey,
          model,
          userId: user.id,
          deckId: rotationDeck.id,
          reason: "before_generation",
        });

        send("progress", {
          ok: true,
          phase: "generating",
          status: "Streaming question generation",
          progress: 18,
          generated: 0,
          total: count,
          memoryUpdated: memoryResult.updated,
        });

        const generation = await generateBulkQuestionsFromMemory({
          apiKey,
          model,
          userId: user.id,
          deck: memoryResult.deck,
          memory: memoryResult.memory,
          count,
          onPartialQuestions: (questions) => {
            send("progress", {
              ok: true,
              phase: "generating",
              status:
                questions.length === 1
                  ? "1 question extracted from stream"
                  : `${questions.length} questions extracted from stream`,
              progress: Math.min(
                72,
                18 + Math.round((questions.length / count) * 54),
              ),
              generated: questions.length,
              total: count,
              latestQuestion: questions.at(-1)?.question ?? null,
            });
          },
        });

        send("progress", {
          ok: true,
          phase: "processing",
          status: "Checking duplicates and adding questions",
          progress: 82,
          generated: generation.questions.length,
          total: count,
        });

        const result = await addQuestionsToDeck({
          questions: generation.questions,
          deckId: rotationDeck.id,
        });

        send("complete", {
          ok: true,
          phase: "complete",
          status: "Questions added",
          progress: 100,
          model: generation.model,
          deckId: rotationDeck.id,
          deckName: rotationDeck.name,
          memoryUpdated: memoryResult.updated,
          generated: generation.questions.length,
          added: result.added,
          rejected: result.rejected,
        });
      } catch (error) {
        send("error", {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not generate questions.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
