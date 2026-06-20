"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { Course, UserProfile } from "./LearnPageClient";

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: Course[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number;
  initialSelectedCourse?: Course | null;
};

export const LearnHydrator =
  createAuthenticatedClientHydrator<LearnPageClientProps>({
    loadClient: () =>
      import("./LearnPageClient").then((module) => module.default),
    staticSelector: "[data-learn-static]",
  });
