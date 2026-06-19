import { NextResponse } from "next/server";
import { addQuestionsToKnowledgeBase } from "@/app/lib/reviewQueue";
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
const MAX_QUESTION_CHARS = 1_200;
const MAX_CONCISE_ANSWER_CHARS = 800;
const MAX_PROVENANCE_CHARS = 360;
const MAX_SOURCE_TEXT_CHARS = 4_000;
const MAX_PROPOSED_CONCEPT_SLUGS = 8;
const MAX_PROPOSED_CONCEPT_SLUG_CHARS = 120;

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
      proposedConceptSlugs?: unknown;
      sourceText?: unknown;
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

    const sourceText = normalizeBoundedText(record.sourceText, {
      field: "sourceText",
      maxLength: MAX_SOURCE_TEXT_CHARS,
      required: false,
    });

    if (!sourceText.ok) {
      return sourceText.response;
    }

    const proposedConceptSlugs = Array.isArray(record.proposedConceptSlugs)
      ? record.proposedConceptSlugs
          .slice(0, MAX_PROPOSED_CONCEPT_SLUGS)
          .map((slug) =>
            typeof slug === "string"
              ? slug.trim().slice(0, MAX_PROPOSED_CONCEPT_SLUG_CHARS)
              : "",
          )
          .filter(Boolean)
      : [];

    questions.push({
      question: normalizedQuestion.value,
      conciseAnswer: conciseAnswer.value,
      questionProvenance: questionProvenance.value,
      proposedConceptSlugs,
      sourceText: sourceText.value,
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
    const result = await addQuestionsToKnowledgeBase({ questions });

    return NextResponse.json({
      ok: true,
      added: result.added,
      rejected: result.rejected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add questions.";

    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}
