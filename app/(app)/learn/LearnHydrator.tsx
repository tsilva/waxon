"use client";

import { AuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { Course, UserProfile } from "./LearnPageClient";

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: Course[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number;
  initialSelectedCourse?: Course | null;
};

type LearnPageClientComponent = (
  props: LearnPageClientProps,
) => React.ReactElement;

function loadLearnPageClient(): Promise<LearnPageClientComponent> {
  return import("./LearnPageClient").then(
    (learnModule) => learnModule.default as LearnPageClientComponent,
  );
}

export function LearnHydrator(initialProps: LearnPageClientProps) {
  return (
    <AuthenticatedClientHydrator
      componentProps={initialProps}
      loadClient={loadLearnPageClient}
      staticSelector="[data-learn-static]"
    />
  );
}
