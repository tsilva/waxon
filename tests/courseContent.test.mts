import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COURSE_PAGES,
  coursePageCount,
  nextCoursePosition,
  parseCoursePageJson,
  validateCoursePageContent,
  validateCourseToc,
} from "../app/lib/courseContent.ts";

function validPage(overrides: Record<string, unknown> = {}) {
  return {
    title: "Posterior intuition",
    body: "A posterior updates prior belief with likelihood evidence.",
    summary: "Posterior belief combines prior and likelihood.",
    question: "What does a Bayesian posterior represent?",
    choices: [
      { id: "A", text: "A prior before evidence" },
      { id: "B", text: "A likelihood without normalization" },
      { id: "C", text: "Updated belief after evidence" },
      { id: "D", text: "A fixed frequentist parameter" },
    ],
    correctChoiceId: "C",
    correctAnswer: "Updated belief after evidence",
    explanation: "The posterior is the updated belief conditioned on evidence.",
    ...overrides,
  };
}

test("validateCourseToc normalizes and caps generated course shape", () => {
  const toc = validateCourseToc({
    title: " Bayesian inference ",
    description: " Learn the core mechanics. ",
    chapters: Array.from({ length: 6 }, (_, chapterIndex) => ({
      title: `Chapter ${chapterIndex + 1}`,
      pages: Array.from({ length: 4 }, (_, pageIndex) => ({
        title: `Page ${chapterIndex + 1}.${pageIndex + 1}`,
        objective: "Understand the next idea.",
      })),
    })),
  });

  assert.equal(toc.title, "Bayesian inference");
  assert.equal(toc.chapters.length, 4);
  assert.equal(coursePageCount(toc), MAX_COURSE_PAGES);
});

test("nextCoursePosition advances within and across chapters", () => {
  const toc = validateCourseToc({
    title: "Course",
    description: "Description",
    chapters: [
      {
        title: "One",
        pages: [
          { title: "One A", objective: "A" },
          { title: "One B", objective: "B" },
        ],
      },
      {
        title: "Two",
        pages: [{ title: "Two A", objective: "A" }],
      },
    ],
  });

  assert.deepEqual(nextCoursePosition({ toc, chapterIndex: 0, pageIndex: 0 }), {
    chapterIndex: 0,
    pageIndex: 1,
  });
  assert.deepEqual(nextCoursePosition({ toc, chapterIndex: 0, pageIndex: 1 }), {
    chapterIndex: 1,
    pageIndex: 0,
  });
  assert.equal(nextCoursePosition({ toc, chapterIndex: 1, pageIndex: 0 }), null);
});

test("parseCoursePageJson accepts valid markdown page and MCQ", () => {
  const page = parseCoursePageJson(JSON.stringify(validPage()));

  assert.equal(page.choices.length, 4);
  assert.equal(page.correctChoiceId, "C");
  assert.equal(page.correctAnswer, "Updated belief after evidence");
});

test("validateCoursePageContent rejects malformed MCQs", () => {
  assert.throws(
    () => validateCoursePageContent(validPage({ choices: [] })),
    /exactly 4 choices/u,
  );
  assert.throws(
    () => validateCoursePageContent(validPage({ correctChoiceId: "Z" })),
    /correctChoiceId/u,
  );
  assert.throws(
    () => validateCoursePageContent(validPage({ correctAnswer: "Wrong" })),
    /correctAnswer/u,
  );
});

test("validateCoursePageContent rejects choices embedded in review question", () => {
  assert.throws(
    () =>
      validateCoursePageContent(
        validPage({
          question:
            "What does a Bayesian posterior represent?\nA. Prior\nB. Likelihood",
        }),
      ),
    /must not include multiple-choice options/u,
  );
});
