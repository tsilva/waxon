"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";

export const LearnCoursesHydrator = createAuthenticatedClientHydrator({
  loadClient: () =>
    import("./LearnCoursesPageClient").then((module) => module.default),
  staticSelector: "[data-learn-static]",
});
