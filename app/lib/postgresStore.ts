import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, count, eq, lte, sql } from "drizzle-orm";
import { db } from "@/app/db/client";
import { decks, questionAttempts, questions, users } from "@/app/db/schema";
import { getCurrentUser } from "./auth";
import { appendReview, parseReviews, scheduleNextReview } from "./scheduler";

export type QuestionRow = {
  deck_id: string;
  deck_name: string;
  user_id: string;
  question: string;
  reviews: string;
  next_due: number;
  last_answer: string;
  last_answer_summary: string;
  reference_answer: string;
};

export type DueQuestion = {
  deckId: string;
  deckName: string;
  question: string;
  reviews: string;
  nextDue: number;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
};

export type QuestionAttempt = {
  id: number;
  deckId: string;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
};

export type PersistedEvaluation = {
  deckId: string;
  deckName: string;
  question: string;
  reviews: string;
  nextDue: number;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  referenceAnswer: string | null;
} | null;

const LEGACY_QUESTIONS_FILE = path.join(process.cwd(), "data", "questions.csv");
const DEFAULT_DECK = {
  id: "deep-learning",
  name: "Deep Learning",
  slug: "deep-learning",
};

let databaseSeeded = false;

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }

      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readLegacyCsvQuestions(): Array<{
  question: string;
  reviews: string;
  nextDue: number;
}> {
  if (!existsSync(LEGACY_QUESTIONS_FILE)) {
    return [];
  }

  const rows = parseCsvRows(readFileSync(LEGACY_QUESTIONS_FILE, "utf8"));
  const header = rows[0] ?? [];
  const questionIndex = header.indexOf("question");
  const reviewsIndex = header.indexOf("reviews");
  const nextDueIndex = header.indexOf("next_due");

  if (questionIndex === -1) {
    return [];
  }

  return rows
    .slice(1)
    .filter((row) => row[questionIndex]?.trim())
    .map((row) => {
      const nextDue = Number(nextDueIndex === -1 ? 0 : row[nextDueIndex]);

      return {
        question: row[questionIndex] ?? "",
        reviews: reviewsIndex === -1 ? "" : (row[reviewsIndex] ?? ""),
        nextDue: Number.isFinite(nextDue) ? Math.round(nextDue) : 0,
      };
    });
}

function currentDeckId(): string {
  return DEFAULT_DECK.id;
}

function toDueQuestion(row: QuestionRow): DueQuestion {
  return {
    deckId: row.deck_id,
    deckName: row.deck_name,
    question: row.question,
    reviews: row.reviews,
    nextDue: row.next_due,
    lastAnswer: row.last_answer || null,
    lastAnswerSummary: row.last_answer_summary || null,
    referenceAnswer: row.reference_answer || null,
  };
}

async function seedCurrentUserAndDeck(): Promise<void> {
  const now = Date.now();
  const user = getCurrentUser();

  await db
    .insert(users)
    .values({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        displayName: user.displayName,
        email: user.email,
        updatedAt: now,
      },
    });

  await db
    .insert(decks)
    .values({
      id: DEFAULT_DECK.id,
      userId: user.id,
      name: DEFAULT_DECK.name,
      slug: DEFAULT_DECK.slug,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: decks.id,
      set: {
        userId: user.id,
        name: DEFAULT_DECK.name,
        slug: DEFAULT_DECK.slug,
        updatedAt: now,
      },
    });
}

async function ensureSeedData(): Promise<void> {
  if (databaseSeeded) {
    return;
  }

  await seedCurrentUserAndDeck();

  const [{ value: questionCount = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(questions)
    .where(eq(questions.deckId, currentDeckId()));

  if (questionCount === 0) {
    const seedRows = readLegacyCsvQuestions();

    if (seedRows.length > 0) {
      await db
        .insert(questions)
        .values(
          seedRows.map((row) => ({
            deckId: currentDeckId(),
            question: row.question,
            reviews: row.reviews,
            nextDue: row.nextDue,
          })),
        )
        .onConflictDoNothing();
    }
  }

  databaseSeeded = true;
}

async function selectQuestionRows(whereClause = sql`true`): Promise<QuestionRow[]> {
  await ensureSeedData();

  const user = getCurrentUser();
  const rows = await db
    .select({
      deck_id: questions.deckId,
      deck_name: decks.name,
      user_id: decks.userId,
      question: questions.question,
      reviews: questions.reviews,
      next_due: questions.nextDue,
      last_answer: questions.lastAnswer,
      last_answer_summary: questions.lastAnswerSummary,
      reference_answer: questions.referenceAnswer,
    })
    .from(questions)
    .innerJoin(decks, eq(decks.id, questions.deckId))
    .where(
      and(
        eq(questions.deckId, currentDeckId()),
        eq(decks.userId, user.id),
        whereClause,
      ),
    )
    .orderBy(asc(questions.nextDue), asc(questions.question));

  return rows;
}

export async function ensureQuestionsDatabase(): Promise<void> {
  await ensureSeedData();
}

export async function readQuestions(): Promise<QuestionRow[]> {
  return selectQuestionRows();
}

export async function getDueQuestions(now = Date.now()): Promise<DueQuestion[]> {
  const rows = await selectQuestionRows(lte(questions.nextDue, Math.round(now)));

  return rows
    .map(toDueQuestion)
    .filter((row) => Number.isFinite(row.nextDue) && row.nextDue <= now)
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getAllQueuedQuestions(): Promise<DueQuestion[]> {
  const rows = await selectQuestionRows();

  return rows
    .map(toDueQuestion)
    .filter((row) => Number.isFinite(row.nextDue))
    .sort((a, b) => a.nextDue - b.nextDue);
}

export async function getQuestionSnapshot(
  question: string,
): Promise<DueQuestion | null> {
  const [row] = await selectQuestionRows(eq(questions.question, question));

  return row ? toDueQuestion(row) : null;
}

export async function getQuestionAttempts(
  question: string,
): Promise<QuestionAttempt[]> {
  await ensureSeedData();

  const rows = await db
    .select({
      id: questionAttempts.id,
      deckId: questionAttempts.deckId,
      question: questionAttempts.question,
      rawAnswer: questionAttempts.rawAnswer,
      answerSummary: questionAttempts.answerSummary,
      score: questionAttempts.score,
      justification: questionAttempts.justification,
      submittedAt: questionAttempts.submittedAt,
      resolvedAt: questionAttempts.resolvedAt,
    })
    .from(questionAttempts)
    .where(
      and(
        eq(questionAttempts.deckId, currentDeckId()),
        eq(questionAttempts.question, question),
      ),
    )
    .orderBy(asc(questionAttempts.submittedAt), asc(questionAttempts.id));

  return rows.filter(
    (attempt) =>
      Number.isFinite(attempt.id) &&
      Number.isFinite(attempt.score) &&
      Number.isFinite(attempt.submittedAt) &&
      Number.isFinite(attempt.resolvedAt),
  );
}

export async function getStoredReferenceAnswer(
  question: string,
): Promise<string | null> {
  const snapshot = await getQuestionSnapshot(question);
  const answer = snapshot?.referenceAnswer?.trim() ?? "";

  return answer || null;
}

export async function saveReferenceAnswer(input: {
  question: string;
  answer: string;
  now: number;
}): Promise<void> {
  await ensureSeedData();

  await db
    .update(questions)
    .set({
      referenceAnswer: input.answer,
      updatedAt: Math.round(input.now),
    })
    .where(
      and(
        eq(questions.deckId, currentDeckId()),
        eq(questions.question, input.question),
      ),
    );
}

export async function applyEvaluationToPostgres(input: {
  question: string;
  answer: string;
  answerSummary: string;
  justification: string;
  score: number;
  submittedAt: number;
  now: number;
}): Promise<PersistedEvaluation> {
  await ensureSeedData();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        deck_id: questions.deckId,
        deck_name: decks.name,
        user_id: decks.userId,
        question: questions.question,
        reviews: questions.reviews,
        next_due: questions.nextDue,
        last_answer: questions.lastAnswer,
        last_answer_summary: questions.lastAnswerSummary,
        reference_answer: questions.referenceAnswer,
      })
      .from(questions)
      .innerJoin(decks, eq(decks.id, questions.deckId))
      .where(
        and(
          eq(questions.deckId, currentDeckId()),
          eq(decks.userId, getCurrentUser().id),
          eq(questions.question, input.question),
        ),
      )
      .for("update");

    if (!row) {
      return null;
    }

    const previousReviews = parseReviews(row.reviews);
    const reviews = appendReview(row.reviews, {
      ts: input.now,
      score: input.score,
    });
    const nextDue = scheduleNextReview({
      previousReviews,
      newScore: input.score,
      now: input.now,
    });
    const roundedNextDue = Math.round(nextDue);

    await tx
      .update(questions)
      .set({
        reviews,
        nextDue: roundedNextDue,
        lastAnswer: input.answer,
        lastAnswerSummary: input.answerSummary,
        updatedAt: Math.round(input.now),
      })
      .where(
        and(
          eq(questions.deckId, currentDeckId()),
          eq(questions.question, input.question),
        ),
      );

    await tx.insert(questionAttempts).values({
      deckId: currentDeckId(),
      question: input.question,
      rawAnswer: input.answer,
      answerSummary: input.answerSummary,
      score: input.score,
      justification: input.justification,
      submittedAt: Math.round(input.submittedAt),
      resolvedAt: Math.round(input.now),
    });

    return {
      deckId: row.deck_id,
      deckName: row.deck_name,
      question: row.question,
      reviews,
      nextDue: roundedNextDue,
      lastAnswer: input.answer || null,
      lastAnswerSummary: input.answerSummary || null,
      referenceAnswer: row.reference_answer || null,
    };
  });
}
