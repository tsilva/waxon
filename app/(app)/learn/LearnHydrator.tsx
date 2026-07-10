"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type {
  Course,
  CourseListItem,
  UserProfile,
} from "./learnTypes";

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: CourseListItem[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number | null;
  initialIsStartingNewCourse?: boolean;
  initialSelectedCourse?: Course | null;
};

export const LearnHydrator =
  createAuthenticatedClientHydrator<LearnPageClientProps>({
    loadClient: () =>
      import("./LearnPageClient").then((module) => module.default),
    staticSelector: "[data-learn-static]",
  });
