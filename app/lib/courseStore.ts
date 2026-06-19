import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/app/db/client";
import {
  courseChatMessages,
  coursePageAttempts,
  coursePages,
  courses,
} from "@/app/db/schema";
import { getCurrentUser } from "./auth";
import {
  coursePageCount,
  flatCoursePageIndex,
  nextCoursePosition,
  validateCourseToc,
  type CourseChoice,
  type CourseMultipleChoiceWidget,
  type CoursePageContent,
  type CourseToc,
} from "./courseContent";
import {
  applyEvaluationToPostgres,
  upsertDueQuestions,
  type DueQuestion,
} from "./postgresStore";
import { reformatMultipleChoiceQuestionForReview } from "./courseQuestionAttemptParsing";

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
  widget: CourseMultipleChoiceWidget;
  createdAt: number;
  updatedAt: number;
};

export type CourseChatMessageRecord = {
  id: string;
  courseId: string;
  role: "assistant" | "user";
  content: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
};

export type CourseRecord = {
  id: string;
  userId: string;
  topicPrompt: string;
  title: string;
  description: string;
  toc: CourseToc;
  status: CourseStatus;
  currentChapterIndex: number;
  currentPageIndex: number;
  totalPages: number;
  generatedPages: number;
  chatMessageCount: number;
  conversationCost: number;
  createdAt: number;
  updatedAt: number;
};

export type CourseDetail = CourseRecord & {
  pages: CoursePageRecord[];
  chatMessages: CourseChatMessageRecord[];
};

export type CourseAnswerResult = {
  correct: boolean;
  feedback: string;
  course: CourseDetail;
};

export type CourseChatQuestionAttemptInput = {
  course: CourseDetail;
  question: string;
  answer: string;
  answerSummary: string;
  conciseAnswer: string;
  correctAnswer: string | null;
  justification: string;
  score: number;
  submittedAt: number;
};

export type CourseChatQuestionAttemptResult = {
  questionId: string;
  attemptSaved: boolean;
};

function toCourseStatus(value: string): CourseStatus {
  return value === "completed" ? "completed" : "active";
}

function toCourseChatRole(value: string): CourseChatMessageRecord["role"] {
  return value === "assistant" ? "assistant" : "user";
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

function toCourseChatMessage(row: {
  id: string;
  courseId: string;
  role: string;
  content: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
}): CourseChatMessageRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    role: toCourseChatRole(row.role),
    content: row.content,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
    widget: {
      type: "multiple_choice",
      id: `page-${row.id}-check`,
      question: row.question,
      choices: toChoices(row.choices),
      correctChoiceId: row.correctChoiceId,
      correctAnswer: row.correctAnswer,
      explanation: row.explanation,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadCourseRows(userId: string, courseId?: string) {
  return db
    .select({
      id: courses.id,
      userId: courses.userId,
      topicPrompt: courses.topicPrompt,
      title: courses.title,
      description: courses.description,
      toc: courses.toc,
      status: courses.status,
      currentChapterIndex: courses.currentChapterIndex,
      currentPageIndex: courses.currentPageIndex,
      conversationCost: courses.conversationCost,
      createdAt: courses.createdAt,
      updatedAt: courses.updatedAt,
      generatedPages: sql<number>`(
        SELECT count(*)::int
        FROM ${coursePages}
        WHERE ${coursePages.courseId} = ${courses.id}
      )`,
      chatMessageCount: sql<number>`(
        SELECT count(*)::int
        FROM ${courseChatMessages}
        WHERE ${courseChatMessages.courseId} = ${courses.id}
      )`,
    })
    .from(courses)
    .where(
      courseId
        ? and(eq(courses.userId, userId), eq(courses.id, courseId))
        : eq(courses.userId, userId),
    )
    .orderBy(desc(courses.updatedAt));
}

function hydrateCourse(input: {
  row: Awaited<ReturnType<typeof loadCourseRows>>[number];
}): CourseRecord {
  const toc = validateCourseToc(input.row.toc);
  const position = {
    chapterIndex: 0,
    pageIndex: Math.min(
      flatCoursePageIndex({
        tocValue: input.row.toc,
        chapterIndex: input.row.currentChapterIndex,
        pageIndex: input.row.currentPageIndex,
      }),
      Math.max(toc.pages.length - 1, 0),
    ),
  };

  return {
    id: input.row.id,
    userId: input.row.userId,
    topicPrompt: input.row.topicPrompt,
    title: input.row.title,
    description: input.row.description,
    toc,
    status: toCourseStatus(input.row.status),
    currentChapterIndex: position.chapterIndex,
    currentPageIndex: position.pageIndex,
    totalPages: coursePageCount(toc),
    generatedPages: Number(input.row.generatedPages ?? 0),
    chatMessageCount: Number(input.row.chatMessageCount ?? 0),
    conversationCost: Math.max(0, Number(input.row.conversationCost ?? 0)),
    createdAt: input.row.createdAt,
    updatedAt: input.row.updatedAt,
  };
}

export async function listCourses(): Promise<CourseRecord[]> {
  const user = await getCurrentUser();
  const rows = await loadCourseRows(user.id);

  return rows.map((row) => hydrateCourse({ row }));
}

export async function getCourse(courseId: string): Promise<CourseDetail | null> {
  const user = await getCurrentUser();
  const [row] = await loadCourseRows(user.id, courseId);

  if (!row) {
    return null;
  }

  const rawToc = row.toc;
  const course = hydrateCourse({ row });
  const [pageRows, chatRows] = await Promise.all([
    db
      .select()
      .from(coursePages)
      .where(eq(coursePages.courseId, course.id))
      .orderBy(asc(coursePages.chapterIndex), asc(coursePages.pageIndex)),
    db
      .select()
      .from(courseChatMessages)
      .where(eq(courseChatMessages.courseId, course.id))
      .orderBy(asc(courseChatMessages.sequence)),
  ]);

  return {
    ...course,
    pages: pageRows.map((row) => {
      const page = toCoursePage(row);
      const pageIndex = flatCoursePageIndex({
        tocValue: rawToc,
        chapterIndex: row.chapterIndex,
        pageIndex: row.pageIndex,
      });

      return {
        ...page,
        chapterIndex: 0,
        pageIndex,
      };
    }),
    chatMessages: chatRows.map(toCourseChatMessage),
  };
}

export async function deleteCourse(courseId: string): Promise<void> {
  const course = await getCourse(courseId);

  if (!course) {
    throw new Error("Course not found.");
  }

  await db.delete(courses).where(and(eq(courses.userId, course.userId), eq(courses.id, course.id)));
}

export async function createCourse(input: {
  topic: string;
  toc: CourseToc;
}): Promise<CourseDetail> {
  const user = await getCurrentUser();
  const toc = validateCourseToc(input.toc);
  const now = Date.now();
  const [course] = await db
    .insert(courses)
    .values({
      userId: user.id,
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

export async function updateCourseToc(input: {
  courseId: string;
  toc: CourseToc;
}): Promise<CourseDetail> {
  const user = await getCurrentUser();
  const toc = validateCourseToc(input.toc);
  const now = Date.now();

  const [course] = await db
    .update(courses)
    .set({
      title: toc.title,
      description: toc.description,
      toc,
      updatedAt: now,
    })
    .where(and(eq(courses.userId, user.id), eq(courses.id, input.courseId)))
    .returning({ id: courses.id });

  if (!course) {
    throw new Error("Course could not be updated.");
  }

  const detail = await getCourse(course.id);

  if (!detail) {
    throw new Error("Updated course could not be loaded.");
  }

  return detail;
}

export async function replaceCourseChatMessages(input: {
  courseId: string;
  messages: Array<{
    role: "assistant" | "user";
    content: string;
  }>;
}): Promise<CourseChatMessageRecord[]> {
  const course = await getCourse(input.courseId);

  if (!course) {
    throw new Error("Course could not be loaded.");
  }

  const now = Date.now();
  const messages = input.messages
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.trim(),
    }))
    .filter((message) => message.content);

  return db.transaction(async (tx) => {
    await tx
      .delete(courseChatMessages)
      .where(eq(courseChatMessages.courseId, course.id));

    if (messages.length === 0) {
      await tx
        .update(courses)
        .set({ updatedAt: now })
        .where(eq(courses.id, course.id));

      return [];
    }

    const rows = await tx
      .insert(courseChatMessages)
      .values(
        messages.map((message, index) => ({
          courseId: course.id,
          role: message.role,
          content: message.content,
          sequence: index,
          createdAt: now + index,
          updatedAt: now + index,
        })),
      )
      .returning();

    await tx
      .update(courses)
      .set({ updatedAt: now })
      .where(eq(courses.id, course.id));

    return rows.map(toCourseChatMessage);
  });
}

export async function addCourseConversationCost(input: {
  courseId: string;
  cost: number;
}): Promise<void> {
  if (!Number.isFinite(input.cost) || input.cost <= 0) {
    return;
  }

  const user = await getCurrentUser();

  const now = Date.now();

  await db
    .update(courses)
    .set({
      conversationCost: sql`${courses.conversationCost} + ${input.cost}`,
      updatedAt: now,
    })
    .where(and(eq(courses.userId, user.id), eq(courses.id, input.courseId)));
}

export async function getCoursePageByPosition(input: {
  courseId: string;
  chapterIndex: number;
  pageIndex: number;
}): Promise<CoursePageRecord | null> {
  const user = await getCurrentUser();
  const [row] = await db
    .select()
    .from(coursePages)
    .innerJoin(
      courses,
      and(eq(courses.id, coursePages.courseId), eq(courses.userId, user.id)),
    )
    .where(
      and(
        eq(coursePages.courseId, input.courseId),
        eq(coursePages.chapterIndex, input.chapterIndex),
        eq(coursePages.pageIndex, input.pageIndex),
      ),
    )
    .limit(1);

  return row ? toCoursePage(row.course_pages) : null;
}

function courseQuestionProvenance(input: {
  course: CourseDetail;
  chapterIndex: number;
  pageIndex: number;
}): string {
  const page = input.course.toc.pages[input.pageIndex];

  return [
    `Course: ${input.course.title}`,
    page ? `Page ${input.pageIndex + 1}: ${page.title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function courseChatQuestionProvenance(course: CourseDetail): string {
  const page = course.toc.pages[course.currentPageIndex];

  return [
    `Course chat: ${course.title}`,
    page ? `Milestone ${course.currentPageIndex + 1}: ${page.title}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function recordCourseChatQuestionAttempt(
  input: CourseChatQuestionAttemptInput,
): Promise<CourseChatQuestionAttemptResult | null> {
  const question = reformatMultipleChoiceQuestionForReview(input.question)
    .trim()
    .replace(/\s+/g, " ");
  const answer = input.answer.trim();
  const score = Math.max(0, Math.min(10, Math.round(input.score)));

  if (!question || !answer || !Number.isFinite(score)) {
    return null;
  }

  const now = Date.now();
  const [dueQuestion] = await upsertDueQuestions({
    userId: input.course.userId,
    sourceQuestion: null,
    now,
    questions: [
      {
        question,
        conciseAnswer:
          input.conciseAnswer.trim().replace(/\s+/g, " ") ||
          input.correctAnswer?.trim().replace(/\s+/g, " ") ||
          "",
        questionProvenance: courseChatQuestionProvenance(input.course),
      },
    ],
  });

  if (!dueQuestion) {
    return null;
  }

  const persisted = await applyEvaluationToPostgres({
    questionId: dueQuestion.questionId,
    question: dueQuestion.question,
    answer,
    answerSummary:
      input.answerSummary.trim().replace(/\s+/g, " ") || answer.slice(0, 240),
    correctAnswer:
      input.correctAnswer?.trim().replace(/\s+/g, " ") ||
      input.conciseAnswer.trim().replace(/\s+/g, " ") ||
      null,
    justification:
      input.justification.trim().replace(/\s+/g, " ") ||
      "Recorded from course chat.",
    score,
    submittedAt: input.submittedAt,
    now,
    userId: input.course.userId,
  });

  return {
    questionId: dueQuestion.questionId,
    attemptSaved: Boolean(persisted),
  };
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
    sourceQuestion: null,
    now,
    questions: [
      {
        question: input.page.question,
        conciseAnswer: input.page.correctAnswer,
        proposedConceptSlugs: input.page.proposedConceptSlugs,
        sourceText: input.page.body,
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

export async function advanceCourseProgress(
  courseId: string,
): Promise<CourseDetail | null> {
  const course = await getCourse(courseId);

  if (!course) {
    return null;
  }

  if (course.status === "completed") {
    return course;
  }

  const nextPosition = nextCoursePosition({
    toc: course.toc,
    chapterIndex: course.currentChapterIndex,
    pageIndex: course.currentPageIndex,
  });
  const now = Date.now();

  await db
    .update(courses)
    .set({
      status: nextPosition ? "active" : "completed",
      currentChapterIndex:
        nextPosition?.chapterIndex ?? course.currentChapterIndex,
      currentPageIndex: nextPosition?.pageIndex ?? course.currentPageIndex,
      updatedAt: now,
    })
    .where(eq(courses.id, course.id));

  const updated = await getCourse(course.id);

  if (!updated) {
    throw new Error("Could not reload course.");
  }

  return updated;
}
