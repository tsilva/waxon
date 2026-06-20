import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COURSE_PAGES,
  coursePageCount,
  nextCoursePosition,
  validateCourseToc,
} from "../app/lib/courseContent.ts";

test("validateCourseToc normalizes and caps generated course shape", () => {
  const toc = validateCourseToc({
    title: " Bayesian inference ",
    description: " Learn the core mechanics. ",
    pages: Array.from({ length: 20 }, (_, pageIndex) => ({
      title: `Page ${pageIndex + 1}`,
      objective: "Understand the next idea.",
    })),
  });

  assert.equal(toc.title, "Bayesian inference");
  assert.equal(toc.pages.length, MAX_COURSE_PAGES);
  assert.equal(coursePageCount(toc), MAX_COURSE_PAGES);
});

test("validateCourseToc flattens legacy chaptered course shape", () => {
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

  assert.deepEqual(
    toc.pages.map((page) => page.title),
    ["One A", "One B", "Two A"],
  );
});

test("nextCoursePosition advances through flat pages", () => {
  const toc = validateCourseToc({
    title: "Course",
    description: "Description",
    pages: [
      { title: "One A", objective: "A" },
      { title: "One B", objective: "B" },
      { title: "Two A", objective: "A" },
    ],
  });

  assert.deepEqual(nextCoursePosition({ toc, chapterIndex: 0, pageIndex: 0 }), {
    chapterIndex: 0,
    pageIndex: 1,
  });
  assert.deepEqual(nextCoursePosition({ toc, chapterIndex: 0, pageIndex: 1 }), {
    chapterIndex: 0,
    pageIndex: 2,
  });
  assert.equal(nextCoursePosition({ toc, chapterIndex: 0, pageIndex: 2 }), null);
});
