import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "@/app/db/client";
import {
  coursePageAttempts,
  coursePages,
  courses,
} from "@/app/db/schema";
import { getCurrentUser } from "./auth";
import {
  coursePageCount,
  nextCoursePosition,
  validateCourseToc,
  type CourseChoice,
  type CoursePageContent,
  type CourseToc,
} from "./courseContent";
import {
  createDeck,
  listDecks,
  upsertDueQuestions,
  type DueQuestion,
} from "./postgresStore";

export type CourseStatus = "active" | "completed";

export type CoursePageRecord = {
  id: string;
  courseId: string;
  questionId: string | null;
  chapterIndex: number;
  pageIndex: number;
  title: string;
  body: string;
  summary: string;
  question: string;
  choices: CourseChoice[];
  correctChoiceId: string;
  correctAnswer: string;
  explanation: string;
  createdAt: number;
  updatedAt: number;
};

export type CourseRecord = {
  id: string;
  userId: string;
  deckId: string;
  deckName: string;
  topicPrompt: string;
  title: string;
  description: string;
  toc: CourseToc;
  status: CourseStatus;
  currentChapterIndex: number;
  currentPageIndex: number;
  totalPages: number;
  generatedPages: number;
  createdAt: number;
  updatedAt: number;
};

export type CourseDetail = CourseRecord & {
  pages: CoursePageRecord[];
};

export type CourseAnswerResult = {
  correct: boolean;
  feedback: string;
  course: CourseDetail;
};

function toCourseStatus(value: string): CourseStatus {
  return value === "completed" ? "completed" : "active";
}

function toChoices(value: unknown): CourseChoice[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((choice) => {
      const record = choice as { id?: unknown; text?: unknown };
      return {
        id: typeof record.id === "string" ? record.id : "",
        text: typeof record.text === "string" ? record.text : "",
      };
    })
    .filter((choice) => choice.id && choice.text);
}

function toCoursePage(row: {
  id: string;
  courseId: string;
  questionId: string | null;
  chapterIndex: number;
  pageIndex: number;
  title: string;
  body: string;
  summary: string;
  question: string;
  choices: unknown;
  correctChoiceId: string;
  correctAnswer: string;
  explanation: string;
  createdAt: number;
  updatedAt: number;
}): CoursePageRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    questionId: row.questionId,
    chapterIndex: row.chapterIndex,
    pageIndex: row.pageIndex,
    title: row.title,
    body: row.body,
    summary: row.summary,
    question: row.question,
    choices: toChoices(row.choices),
    correctChoiceId: row.correctChoiceId,
    correctAnswer: row.correctAnswer,
    explanation: row.explanation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function baseCourseDeckName(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ").slice(0, 90);

  return `Course - ${normalized || "Untitled Course"}`;
}

async function createUniqueCourseDeck(input: {
  title: string;
  description: string;
}) {
  const baseName = baseCourseDeckName(input.title);

  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName} (${suffix})`;

    try {
      return await createDeck({
        name,
        coverage: input.description,
        inReviewRotation: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Deck name already exists."
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Could not create a unique course deck.");
}

async function loadCourseRows(userId: string, courseId?: string) {
  const pageCounts = db
    .select({
      courseId: coursePages.courseId,
      generatedPages: count(coursePages.id).as("generated_pages"),
    })
    .from(coursePages)
    .groupBy(coursePages.courseId)
    .as("page_counts");

  return db
    .select({
      id: courses.id,
      userId: courses.userId,
      deckId: courses.deckId,
      topicPrompt: courses.topicPrompt,
      title: courses.title,
      description: courses.description,
      toc: courses.toc,
      status: courses.status,
      currentChapterIndex: courses.currentChapterIndex,
      currentPageIndex: courses.currentPageIndex,
      createdAt: courses.createdAt,
      updatedAt: courses.updatedAt,
      generatedPages: pageCounts.generatedPages,
    })
    .from(courses)
    .leftJoin(pageCounts, eq(pageCounts.courseId, courses.id))
    .where(
      courseId
        ? and(eq(courses.userId, userId), eq(courses.id, courseId))
        : eq(courses.userId, userId),
    )
    .orderBy(desc(courses.updatedAt));
}

async function hydrateCourse(input: {
  row: Awaited<ReturnType<typeof loadCourseRows>>[number];
  userId: string;
}): Promise<CourseRecord> {
  const deck = (await listDecks({ userId: input.userId })).find(
    (item) => item.id === input.row.deckId,
  );
  const toc = validateCourseToc(input.row.toc);

  return {
    id: input.row.id,
    userId: input.row.userId,
    deckId: input.row.deckId,
    deckName: deck?.name ?? baseCourseDeckName(input.row.title),
    topicPrompt: input.row.topicPrompt,
    title: input.row.title,
    description: input.row.description,
    toc,
    status: toCourseStatus(input.row.status),
    currentChapterIndex: input.row.currentChapterIndex,
    currentPageIndex: input.row.currentPageIndex,
    totalPages: coursePageCount(toc),
    generatedPages: Number(input.row.generatedPages ?? 0),
    createdAt: input.row.createdAt,
    updatedAt: input.row.updatedAt,
  };
}

export async function listCourses(): Promise<CourseRecord[]> {
  const user = await getCurrentUser();
  const rows = await loadCourseRows(user.id);

  return Promise.all(rows.map((row) => hydrateCourse({ row, userId: user.id })));
}

export async function getCourse(courseId: string): Promise<CourseDetail | null> {
  const user = await getCurrentUser();
  const [row] = await loadCourseRows(user.id, courseId);

  if (!row) {
    return null;
  }

  const course = await hydrateCourse({ row, userId: user.id });
  const pageRows = await db
    .select()
    .from(coursePages)
    .where(eq(coursePages.courseId, course.id))
    .orderBy(asc(coursePages.chapterIndex), asc(coursePages.pageIndex));

  return {
    ...course,
    pages: pageRows.map(toCoursePage),
  };
}

export async function createCourse(input: {
  topic: string;
  toc: CourseToc;
}): Promise<CourseDetail> {
  const user = await getCurrentUser();
  const toc = validateCourseToc(input.toc);
  const deck = await createUniqueCourseDeck({
    title: toc.title,
    description: toc.description,
  });
  const now = Date.now();
  const [course] = await db
    .insert(courses)
    .values({
      userId: user.id,
      deckId: deck.id,
      topicPrompt: input.topic,
      title: toc.title,
      description: toc.description,
      toc,
      status: "active",
      currentChapterIndex: 0,
      currentPageIndex: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: courses.id });

  if (!course) {
    throw new Error("Could not create course.");
  }

  const detail = await getCourse(course.id);

  if (!detail) {
    throw new Error("Created course could not be loaded.");
  }

  return detail;
}

export async function getCoursePageByPosition(input: {
  courseId: string;
  chapterIndex: number;
  pageIndex: number;
}): Promise<CoursePageRecord | null> {
  const course = await getCourse(input.courseId);

  if (!course) {
    return null;
  }

  return (
    course.pages.find(
      (page) =>
        page.chapterIndex === input.chapterIndex &&
        page.pageIndex === input.pageIndex,
    ) ?? null
  );
}

function courseQuestionProvenance(input: {
  course: CourseDetail;
  chapterIndex: number;
  pageIndex: number;
}): string {
  const chapter = input.course.toc.chapters[input.chapterIndex];
  const page = chapter?.pages[input.pageIndex];

  return [
    `Course: ${input.course.title}`,
    chapter ? `Chapter ${input.chapterIndex + 1}: ${chapter.title}` : "",
    page ? `Page ${input.pageIndex + 1}: ${page.title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function saveCoursePage(input: {
  course: CourseDetail;
  chapterIndex: number;
  pageIndex: number;
  page: CoursePageContent;
}): Promise<CoursePageRecord> {
  const existing = input.course.pages.find(
    (page) =>
      page.chapterIndex === input.chapterIndex &&
      page.pageIndex === input.pageIndex,
  );

  if (existing) {
    return existing;
  }

  const now = Date.now();
  const [question] = await upsertDueQuestions({
    userId: input.course.userId,
    deckId: input.course.deckId,
    sourceQuestion: null,
    now,
    questions: [
      {
        question: input.page.question,
        conciseAnswer: input.page.correctAnswer,
        questionProvenance: courseQuestionProvenance({
          course: input.course,
          chapterIndex: input.chapterIndex,
          pageIndex: input.pageIndex,
        }),
      },
    ],
  });

  const [row] = await db
    .insert(coursePages)
    .values({
      courseId: input.course.id,
      questionId: (question as DueQuestion | undefined)?.questionId ?? null,
      chapterIndex: input.chapterIndex,
      pageIndex: input.pageIndex,
      title: input.page.title,
      body: input.page.body,
      summary: input.page.summary,
      question: input.page.question,
      choices: input.page.choices,
      correctChoiceId: input.page.correctChoiceId,
      correctAnswer: input.page.correctAnswer,
      explanation: input.page.explanation,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (row) {
    await db
      .update(courses)
      .set({ updatedAt: now })
      .where(eq(courses.id, input.course.id));

    return toCoursePage(row);
  }

  const loaded = await getCoursePageByPosition({
    courseId: input.course.id,
    chapterIndex: input.chapterIndex,
    pageIndex: input.pageIndex,
  });

  if (!loaded) {
    throw new Error("Could not save course page.");
  }

  return loaded;
}

export async function answerCoursePage(input: {
  courseId: string;
  pageId: string;
  selectedChoiceId: string;
}): Promise<CourseAnswerResult | null> {
  const course = await getCourse(input.courseId);

  if (!course) {
    return null;
  }

  const page = course.pages.find((item) => item.id === input.pageId);

  if (!page) {
    return null;
  }

  const selectedChoiceId = input.selectedChoiceId.trim().toUpperCase();
  const selectedChoice = page.choices.find(
    (choice) => choice.id === selectedChoiceId,
  );

  if (!selectedChoice) {
    throw new Error("Selected choice does not exist.");
  }

  const isCorrect = selectedChoice.id === page.correctChoiceId;
  const feedback = isCorrect
    ? page.explanation || "Correct."
    : "Not quite. Re-read the page and try again.";
  const now = Date.now();

  await db.insert(coursePageAttempts).values({
    courseId: course.id,
    pageId: page.id,
    selectedChoiceId: selectedChoice.id,
    isCorrect,
    feedback,
    attemptedAt: now,
  });

  if (isCorrect) {
    const nextPosition = nextCoursePosition({
      toc: course.toc,
      chapterIndex: page.chapterIndex,
      pageIndex: page.pageIndex,
    });

    await db
      .update(courses)
      .set({
        status: nextPosition ? "active" : "completed",
        currentChapterIndex: nextPosition?.chapterIndex ?? page.chapterIndex,
        currentPageIndex: nextPosition?.pageIndex ?? page.pageIndex,
        updatedAt: now,
      })
      .where(eq(courses.id, course.id));
  }

  const updated = await getCourse(course.id);

  if (!updated) {
    throw new Error("Could not reload course.");
  }

  return {
    correct: isCorrect,
    feedback,
    course: updated,
  };
}
