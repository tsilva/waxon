import { NextResponse } from "next/server";
import { archiveDeck, updateDeck } from "@/app/lib/postgresStore";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    inReviewRotation: unknown;
  }>;

  try {
    const deck = await updateDeck({
      deckId,
      name: typeof payload.name === "string" ? payload.name : undefined,
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
    await archiveDeck({ deckId });
    invalidateReviewQueue();

    return NextResponse.json({
      ok: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not archive deck.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Deck not found." ? 404 : 400 },
    );
  }
}
