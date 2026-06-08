import { NextResponse } from "next/server";
import { deleteDeck, updateDeck } from "@/app/lib/postgresStore";
import { normalizeBoundedText } from "@/app/lib/apiLimits";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DECK_COVERAGE_CHARS = 2000;

type RouteContext = {
  params: Promise<{
    deckId: string;
  }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  const { deckId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    name: unknown;
    coverage: unknown;
    inReviewRotation: unknown;
  }>;
  const coverage = normalizeBoundedText(payload.coverage, {
    field: "coverage",
    maxLength: MAX_DECK_COVERAGE_CHARS,
  });

  if (!coverage.ok) {
    return coverage.response;
  }

  try {
    const deck = await updateDeck({
      deckId,
      name: typeof payload.name === "string" ? payload.name : undefined,
      coverage: typeof payload.coverage === "string" ? coverage.value : undefined,
      inReviewRotation:
        typeof payload.inReviewRotation === "boolean"
          ? payload.inReviewRotation
          : undefined,
    });

    if (typeof payload.inReviewRotation === "boolean") {
      invalidateReviewQueue();
    }

    return NextResponse.json({
      ok: true,
      deck,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update deck.";

    return NextResponse.json(
      { ok: false, error: message },
      {
        status:
          message === "Deck not found."
            ? 404
            : message === "Deck name already exists."
              ? 409
              : message === "Deck name is required."
                ? 400
                : 500,
      },
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { deckId } = await context.params;

  try {
    await deleteDeck({ deckId });
    invalidateReviewQueue();

    return NextResponse.json({
      ok: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete deck.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Deck not found." ? 404 : 400 },
    );
  }
}
