import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "@/app/db/client";
import {
  courseChatMessages,
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
  type CourseToc,
} from "./courseContent";
import {
  applyEvaluationToPostgres,
  upsertDueQuestions,
} from "./postgresStore";
import { reformatMultipleChoiceQuestionForReview } from "./courseQuestionAttemptParsing";
import type { CourseMessageMetrics } from "./courseMessageMetrics";
import {
  normalizeCourseQuestionWidgetToolCalls,
  type CourseQuestionWidgetAnswerDetails,
  type CourseQuestionWidgetToolCall,
} from "./courseQuestionWidget";
import {
  sanitizeLearnerFacingCourseText,
  sanitizeLearnerFacingCourseWidgetToolCalls,
} from "./courseChatTurn";

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
  toolCalls: CourseQuestionWidgetToolCall[];
  metrics: CourseMessageMetrics | null;
  evaluation: CourseChatMessageEvaluation | null;
  widgetAnswer: CourseQuestionWidgetAnswerDetails | null;
  sequence: number;
  createdAt: number;
  updatedAt: number;
};

export type CourseChatMessageEvaluation = {
  questionId: string | null;
  question: string;
  correctAnswer: string | null;
  score: number;
  feedback: string;
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

export type CourseListCursor = {
  updatedAt: number;
  id: string;
};

export type CourseListPage = {
  courses: CourseRecord[];
  hasMore: boolean;
  nextCursor: CourseListCursor | null;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedString(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function normalizeStoredMetrics(value: unknown): CourseMessageMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return {
    cost: finiteNumber(record.cost),
    promptTokens: finiteNumber(record.promptTokens),
    cachedPromptTokens: finiteNumber(record.cachedPromptTokens),
    uncachedPromptTokens: finiteNumber(record.uncachedPromptTokens),
    cacheWriteTokens: finiteNumber(record.cacheWriteTokens),
    cacheHitPercent: finiteNumber(record.cacheHitPercent),
    outputTokens: finiteNumber(record.outputTokens),
    totalTokens: finiteNumber(record.totalTokens),
    latencyMs: finiteNumber(record.latencyMs),
    tokensPerSecond: finiteNumber(record.tokensPerSecond),
    contextWindowTokens: finiteNumber(record.contextWindowTokens),
    contextPercent: finiteNumber(record.contextPercent),
  };
}

function normalizeStoredEvaluation(
  value: unknown,
): CourseChatMessageEvaluation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const question = normalizedString(record.question, 1_200);
  const feedback = normalizedString(record.feedback, 1_200);
  const score = finiteNumber(record.score);

  if (!question || !feedback || score === null) {
    return null;
  }

  return {
    questionId: normalizedString(record.questionId, 80) || null,
    question,
    correctAnswer: normalizedString(record.correctAnswer, 1_200) || null,
    score: Math.max(0, Math.min(10, Math.round(score))),
    feedback,
  };
}

function normalizeStoredWidgetAnswer(
  value: unknown,
): CourseQuestionWidgetAnswerDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const answer = normalizedString(record.answer, 4_000);

  if (!answer) {
    return null;
  }

  return {
    question: normalizedString(record.question, 1_200) || null,
    widgetId: normalizedString(record.widgetId, 80) || null,
    answer,
  };
}

function toCourseChatMessage(row: {
  id: string;
  courseId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  metrics: unknown;
  evaluation: unknown;
  widgetAnswer: unknown;
  sequence: number;
  createdAt: number;
  updatedAt: number;
}): CourseChatMessageRecord {
  const role = toCourseChatRole(row.role);
  const toolCalls = normalizeCourseQuestionWidgetToolCalls(row.toolCalls);

  return {
    id: row.id,
    courseId: row.courseId,
    role,
    content:
      role === "assistant"
        ? sanitizeLearnerFacingCourseText(row.content)
        : row.content,
    toolCalls:
      role === "assistant"
        ? sanitizeLearnerFacingCourseWidgetToolCalls(toolCalls)
        : toolCalls,
    metrics: normalizeStoredMetrics(row.metrics),
    evaluation: normalizeStoredEvaluation(row.evaluation),
    widgetAnswer: normalizeStoredWidgetAnswer(row.widgetAnswer),
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

async function loadCourseRows(
  userId: string,
  options: {
    courseId?: string;
    cursor?: CourseListCursor | null;
    limit?: number;
    search?: string;
  } = {},
) {
  const filters = [eq(courses.userId, userId)];
  const normalizedSearch = options.search?.trim();

  if (options.courseId) {
    filters.push(eq(courses.id, options.courseId));
  }

  if (options.cursor) {
    filters.push(
      or(
        lt(courses.updatedAt, options.cursor.updatedAt),
        and(
          eq(courses.updatedAt, options.cursor.updatedAt),
          lt(courses.id, options.cursor.id),
        ),
      )!,
    );
  }

  if (normalizedSearch) {
    const pattern = `%${normalizedSearch}%`;

    filters.push(
      or(
        ilike(courses.title, pattern),
        ilike(courses.description, pattern),
        ilike(courses.topicPrompt, pattern),
        sql`${courses.toc}::text ILIKE ${pattern}`,
      )!,
    );
  }

  const query = db
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
    .where(and(...filters))
    .orderBy(desc(courses.updatedAt), desc(courses.id));

  if (typeof options.limit === "number") {
    return query.limit(options.limit);
  }

  return query;
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

export async function listCoursesPage(input: {
  cursor?: CourseListCursor | null;
  limit: number;
  search?: string;
}): Promise<CourseListPage> {
  const user = await getCurrentUser();
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const rows = await loadCourseRows(user.id, {
    cursor: input.cursor ?? null,
    limit: limit + 1,
    search: input.search,
  });
  const pageRows = rows.slice(0, limit);
  const nextRow = pageRows.at(-1);

  return {
    courses: pageRows.map((row) => hydrateCourse({ row })),
    hasMore: rows.length > limit,
    nextCursor:
      rows.length > limit && nextRow
        ? {
            updatedAt: nextRow.updatedAt,
            id: nextRow.id,
          }
        : null,
  };
}

export async function getCourse(courseId: string): Promise<CourseDetail | null> {
  const user = await getCurrentUser();
  const [row] = await loadCourseRows(user.id, { courseId });

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
    toolCalls?: CourseQuestionWidgetToolCall[];
    metrics?: CourseMessageMetrics | null;
    evaluation?: CourseChatMessageEvaluation | null;
    widgetAnswer?: CourseQuestionWidgetAnswerDetails | null;
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
      toolCalls:
        message.role === "assistant"
          ? normalizeCourseQuestionWidgetToolCalls(message.toolCalls)
          : [],
      metrics: normalizeStoredMetrics(message.metrics),
      evaluation:
        message.role === "assistant"
          ? normalizeStoredEvaluation(message.evaluation)
          : null,
      widgetAnswer:
        message.role === "user"
          ? normalizeStoredWidgetAnswer(message.widgetAnswer)
          : null,
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
          toolCalls: message.toolCalls,
          metrics: message.metrics,
          evaluation: message.evaluation,
          widgetAnswer: message.widgetAnswer,
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

type CourseChatMessageWrite = {
  role: "assistant" | "user";
  content: string;
  toolCalls?: CourseQuestionWidgetToolCall[];
  metrics?: CourseMessageMetrics | null;
  evaluation?: CourseChatMessageEvaluation | null;
  widgetAnswer?: CourseQuestionWidgetAnswerDetails | null;
};

function normalizeCourseChatMessageWrite(message: CourseChatMessageWrite) {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content.trim(),
    toolCalls:
      message.role === "assistant"
        ? normalizeCourseQuestionWidgetToolCalls(message.toolCalls)
        : [],
    metrics: normalizeStoredMetrics(message.metrics),
    evaluation:
      message.role === "assistant"
        ? normalizeStoredEvaluation(message.evaluation)
        : null,
    widgetAnswer:
      message.role === "user"
        ? normalizeStoredWidgetAnswer(message.widgetAnswer)
        : null,
  };
}

export async function appendCourseChatMessages(input: {
  courseId: string;
  messages: CourseChatMessageWrite[];
  maxMessages?: number;
}): Promise<CourseChatMessageRecord[]> {
  const user = await getCurrentUser();
  const now = Date.now();
  const messages = input.messages
    .map(normalizeCourseChatMessageWrite)
    .filter((message) => message.content);
  const maxMessages =
    typeof input.maxMessages === "number"
      ? Math.max(1, Math.floor(input.maxMessages))
      : 200;

  const [course] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.userId, user.id), eq(courses.id, input.courseId)))
    .limit(1);

  if (!course) {
    throw new Error("Course could not be loaded.");
  }

  return db.transaction(async (tx) => {
    if (messages.length > 0) {
      const [sequenceRow] = await tx
        .select({
          maxSequence: sql<number | null>`max(${courseChatMessages.sequence})`,
        })
        .from(courseChatMessages)
        .where(eq(courseChatMessages.courseId, course.id));
      const nextSequence = Number(sequenceRow?.maxSequence ?? -1) + 1;

      await tx.insert(courseChatMessages).values(
        messages.map((message, index) => ({
          courseId: course.id,
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls,
          metrics: message.metrics,
          evaluation: message.evaluation,
          widgetAnswer: message.widgetAnswer,
          sequence: nextSequence + index,
          createdAt: now + index,
          updatedAt: now + index,
        })),
      );

      const firstRetainedSequence = nextSequence + messages.length - maxMessages;

      if (firstRetainedSequence > 0) {
        await tx
          .delete(courseChatMessages)
          .where(
            and(
              eq(courseChatMessages.courseId, course.id),
              lt(courseChatMessages.sequence, firstRetainedSequence),
            ),
          );
      }
    }

    await tx
      .update(courses)
      .set({ updatedAt: now })
      .where(eq(courses.id, course.id));

    const rows = await tx
      .select()
      .from(courseChatMessages)
      .where(eq(courseChatMessages.courseId, course.id))
      .orderBy(asc(courseChatMessages.sequence));

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
