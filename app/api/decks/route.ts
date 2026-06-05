import { NextResponse } from "next/server";
import { createDeck, listDecks } from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({
      decks: await listDecks(),
    });
  } catch {
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
    inReviewRotation: unknown;
  }>;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";

  if (!name) {
    return NextResponse.json(
      { ok: false, error: "name is required" },
      { status: 400 },
    );
  }

  try {
    const deck = await createDeck({
      name,
      inReviewRotation:
        typeof payload.inReviewRotation === "boolean"
          ? payload.inReviewRotation
          : false,
    });

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
