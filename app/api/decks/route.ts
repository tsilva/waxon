import { NextResponse } from "next/server";
import { createDeck, listDecks } from "@/app/lib/postgresStore";
import { normalizeBoundedText } from "@/app/lib/apiLimits";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DECK_COVERAGE_CHARS = 2000;

export async function GET() {
  try {
    return NextResponse.json({
      decks: await listDecks(),
    });
  } catch (error) {
    console.info("[waxon] deck listing failed", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    return NextResponse.json(
      { decks: [], error: "Could not load decks." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    name: unknown;
    coverage: unknown;
    inReviewRotation: unknown;
  }>;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const coverage = normalizeBoundedText(payload.coverage, {
    field: "coverage",
    maxLength: MAX_DECK_COVERAGE_CHARS,
  });

  if (!name) {
    return NextResponse.json(
      { ok: false, error: "name is required" },
      { status: 400 },
    );
  }

  if (!coverage.ok) {
    return coverage.response;
  }

  try {
    const deck = await createDeck({
      name,
      coverage: coverage.value,
      inReviewRotation:
        typeof payload.inReviewRotation === "boolean"
          ? payload.inReviewRotation
          : false,
    });

    if (deck.inReviewRotation) {
      invalidateReviewQueue();
    }

    return NextResponse.json({
      ok: true,
      deck,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create deck.";

    return NextResponse.json(
      { ok: false, error: message },
      {
        status:
          message === "Deck name already exists."
            ? 409
            : message === "Deck name is required."
              ? 400
              : 500,
      },
    );
  }
}
