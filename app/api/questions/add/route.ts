import { NextResponse } from "next/server";
import { addQuestionsToDeck } from "@/app/lib/reviewQueue";
import {
  consumeUserRateLimit,
  normalizeBoundedText,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import type { QuestionInput } from "@/app/lib/postgresStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ADD_QUESTIONS_BODY_BYTES = 64 * 1024;
const MAX_ADD_QUESTION_COUNT = 80;
const MAX_DECK_ID_CHARS = 180;
const MAX_QUESTION_CHARS = 1_200;
const MAX_CONCISE_ANSWER_CHARS = 800;
const MAX_PROVENANCE_CHARS = 360;

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(
    request,
    MAX_ADD_QUESTIONS_BODY_BYTES,
  );

  if (!parsed.ok) {
    return parsed.response;
  }

  const body = parsed.value;
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

  if (payload.questions.length > MAX_ADD_QUESTION_COUNT) {
    return NextResponse.json(
      {
        ok: false,
        error: `questions must include ${MAX_ADD_QUESTION_COUNT} items or fewer`,
      },
      { status: 400 },
    );
  }

  const deckId = normalizeBoundedText(payload.deckId, {
    field: "deckId",
    maxLength: MAX_DECK_ID_CHARS,
    required: false,
  });

  if (!deckId.ok) {
    return deckId.response;
  }

  const questions: Array<string | QuestionInput> = [];

  for (const question of payload.questions) {
    if (typeof question === "string") {
      const normalizedQuestion = normalizeBoundedText(question, {
        field: "question",
        maxLength: MAX_QUESTION_CHARS,
        required: true,
      });

      if (!normalizedQuestion.ok) {
        return normalizedQuestion.response;
      }

      questions.push(normalizedQuestion.value);
      continue;
    }

    const record = question as {
      question: string;
      conciseAnswer?: unknown;
      questionProvenance?: unknown;
    };
    const normalizedQuestion = normalizeBoundedText(record.question, {
      field: "question",
      maxLength: MAX_QUESTION_CHARS,
      required: true,
    });

    if (!normalizedQuestion.ok) {
      return normalizedQuestion.response;
    }

    const conciseAnswer = normalizeBoundedText(record.conciseAnswer, {
      field: "conciseAnswer",
      maxLength: MAX_CONCISE_ANSWER_CHARS,
      required: false,
    });

    if (!conciseAnswer.ok) {
      return conciseAnswer.response;
    }

    const questionProvenance = normalizeBoundedText(record.questionProvenance, {
      field: "questionProvenance",
      maxLength: MAX_PROVENANCE_CHARS,
      required: false,
    });

    if (!questionProvenance.ok) {
      return questionProvenance.response;
    }

    questions.push({
      question: normalizedQuestion.value,
      conciseAnswer: conciseAnswer.value,
      questionProvenance: questionProvenance.value,
    });
  }

  const user = await getCurrentUser();
  const rateLimitResponse = consumeUserRateLimit({
    userId: user.id,
    route: "questions-add",
    rules: [
      { name: "minute", max: 6, windowMs: 60_000 },
      { name: "day", max: 80, windowMs: 24 * 60 * 60_000 },
    ],
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const result = await addQuestionsToDeck({
      questions,
      deckId: deckId.value || undefined,
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
