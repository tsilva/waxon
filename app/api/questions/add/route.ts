import { NextResponse } from "next/server";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";
import type { QuestionInput } from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const payload = body as Partial<{
    questions: unknown;
    deckId: unknown;
  }>;

  if (
    !Array.isArray(payload.questions) ||
    !payload.questions.every(
      (question) =>
        typeof question === "string" ||
        (question &&
          typeof question === "object" &&
          typeof (question as { question?: unknown }).question === "string"),
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "questions must be an array of strings or objects" },
      { status: 400 },
    );
  }

  const questions: Array<string | QuestionInput> = payload.questions.map(
    (question) => {
      if (typeof question === "string") {
        return question;
      }

      const record = question as {
        question: string;
        conciseAnswer?: unknown;
        questionProvenance?: unknown;
      };

      return {
        question: record.question,
        conciseAnswer:
          typeof record.conciseAnswer === "string" ? record.conciseAnswer : "",
        questionProvenance:
          typeof record.questionProvenance === "string"
            ? record.questionProvenance
            : "",
      };
    },
  );
  const deckId = typeof payload.deckId === "string" ? payload.deckId.trim() : "";

  try {
    const result = await addQuestionsToDeck({
      questions,
      deckId: deckId || undefined,
    });

    return NextResponse.json({
      ok: true,
      added: result.added,
      rejected: result.rejected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add questions.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Deck not found." ? 404 : 500 },
    );
  }
}
