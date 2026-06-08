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
import {
  getOpenRouterApiKey,
} from "@/app/lib/openRouter";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_MODEL = process.env.LLM_MODEL?.trim() ?? "";
const MAX_TOP_UP_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_TOP_UP_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "OPENROUTER_API_KEY is not configured." },
      { status: 500 },
    );
  }

  if (!OPENROUTER_MODEL) {
    return NextResponse.json(
      { ok: false, error: "LLM_MODEL is not configured." },
      { status: 500 },
    );
  }

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

  const memoryResult = await refreshDeckMemory({
    apiKey,
    model: OPENROUTER_MODEL,
    userId: user.id,
    deckId: rotationDeck.id,
    reason: "before_generation",
  });
  const generation = await generateBulkQuestionsFromMemory({
    apiKey,
    model: OPENROUTER_MODEL,
    userId: user.id,
    deck: memoryResult.deck,
    memory: memoryResult.memory,
    count,
  });
  const result = await addQuestionsToDeck({
    questions: generation.questions,
    deckId: rotationDeck.id,
  });

  return NextResponse.json({
    ok: true,
    model: generation.model,
    deckId: rotationDeck.id,
    deckName: rotationDeck.name,
    memoryUpdated: memoryResult.updated,
    generated: generation.questions.length,
    added: result.added,
    rejected: result.rejected,
  });
}
