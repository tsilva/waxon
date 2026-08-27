import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getV2Db } from "@/app/db/v2/client";
import { learnerSettings, questions, users } from "@/app/db/v2/schema";
import {
  BROWSER_SMOKE_ISOLATION_QUESTION,
  BROWSER_SMOKE_ISOLATION_LEARNER,
  BROWSER_SMOKE_QUESTIONS,
  BROWSER_SMOKE_TIMEZONE_QUESTION,
} from "@/app/lib/browserSmokeSupport";
import { questionPromptKey } from "@/app/lib/v2/questionInput";
import {
  addQuestions,
  listLibrary,
  mutateQuestionLifecycle,
  replaceQuestion,
  type AddQuestionResult,
} from "@/app/lib/v2/service";

export class BrowserSmokeSeedConflict extends Error {
  readonly activeQuestions: Array<{ id: string; prompt: string }>;

  constructor(activeQuestions: Array<{ id: string; prompt: string }>) {
    super(
      "Archive every non-fixture Active Question before seeding the deterministic Review Queue.",
    );
    this.name = "BrowserSmokeSeedConflict";
    this.activeQuestions = activeQuestions;
  }
}

export async function seedBrowserSmokeJourney(userId: string) {
  const reviewFixtures = [
    BROWSER_SMOKE_TIMEZONE_QUESTION,
    ...BROWSER_SMOKE_QUESTIONS,
  ];
  const promptKeys = reviewFixtures.map((item) =>
    questionPromptKey(item.prompt),
  );
  const active = await listLibrary({
    userId,
    lifecycle: "active",
    limit: 100,
  });
  const fixturePromptKeys = new Set(promptKeys);
  const unexpectedActive = active.questions
    .filter(
      (question) => !fixturePromptKeys.has(questionPromptKey(question.prompt)),
    )
    .map(({ id, prompt }) => ({ id, prompt }));
  if (unexpectedActive.length > 0) {
    throw new BrowserSmokeSeedConflict(unexpectedActive);
  }

  const runId = randomUUID();
  const existing = await getV2Db()
    .select({
      creationOrder: questions.creationOrder,
      id: questions.id,
      lifecycle: questions.lifecycle,
      targetKey: questions.targetKey,
    })
    .from(questions)
    .where(
      and(
        eq(questions.userId, userId),
        inArray(questions.targetKey, promptKeys),
      ),
    )
    .orderBy(asc(questions.creationOrder), asc(questions.id));
  const existingByTarget = new Map<
    string,
    Array<(typeof existing)[number]>
  >();
  for (const candidate of existing) {
    existingByTarget.set(candidate.targetKey, [
      ...(existingByTarget.get(candidate.targetKey) ?? []),
      candidate,
    ]);
  }

  const results: AddQuestionResult[] = [];
  for (const item of reviewFixtures) {
    const runItem = {
      ...item,
      referenceAnswer: `${item.referenceAnswer}\nFixture run: ${runId}`,
    };
    const targetKey = questionPromptKey(item.prompt);
    const candidates = existingByTarget.get(targetKey) ?? [];
    const prior =
      candidates.find((candidate) => candidate.lifecycle === "active") ??
      candidates.findLast((candidate) => candidate.lifecycle === "flagged") ??
      candidates.at(-1);
    if (prior) {
      for (const candidate of candidates) {
        if (candidate.id === prior.id || candidate.lifecycle === "archived") {
          continue;
        }
        await mutateQuestionLifecycle({
          userId,
          questionId: candidate.id,
          action: "archive",
        });
      }
      const replacement = await replaceQuestion({
        userId,
        questionId: prior.id,
        ...runItem,
      });
      if (
        replacement.status === "unchanged" &&
        replacement.lifecycle !== "active"
      ) {
        await mutateQuestionLifecycle({
          userId,
          questionId: replacement.questionId,
          action: "restore",
        });
      }
      results.push({
        id: replacement.questionId,
        status: replacement.status === "replaced" ? "created" : "existing",
        outcome:
          replacement.status === "replaced"
            ? "created_active"
            : "exact_duplicate",
        lifecycle: "active",
        flags: [],
        answerStandardConflict: false,
      });
      continue;
    }
    const created = await addQuestions({
      userId,
      idempotencyKey: `browser-smoke-${targetKey}-${runId}`,
      items: [runItem],
    });
    results.push(...created.results);
  }

  const now = new Date();
  await getV2Db()
    .insert(users)
    .values({
      ...BROWSER_SMOKE_ISOLATION_LEARNER,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        displayName: BROWSER_SMOKE_ISOLATION_LEARNER.displayName,
        email: BROWSER_SMOKE_ISOLATION_LEARNER.email,
        updatedAt: now,
      },
    });
  await getV2Db()
    .insert(learnerSettings)
    .values({ userId: BROWSER_SMOKE_ISOLATION_LEARNER.id })
    .onConflictDoNothing({ target: learnerSettings.userId });
  await addQuestions({
    userId: BROWSER_SMOKE_ISOLATION_LEARNER.id,
    idempotencyKey: `browser-smoke-isolation-${runId}`,
    items: [BROWSER_SMOKE_ISOLATION_QUESTION],
  });

  return {
    runId,
    questions: results,
    fixturePrompts: BROWSER_SMOKE_QUESTIONS.map((item) => item.prompt),
    timezoneBoundaryPrompt: BROWSER_SMOKE_TIMEZONE_QUESTION.prompt,
    isolationProbe: BROWSER_SMOKE_ISOLATION_QUESTION.prompt,
  };
}
