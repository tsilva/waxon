"use client";

import { useEffect, useState } from "react";
import type { Course, UserProfile } from "./LearnPageClient";

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: Course[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number;
  initialSelectedCourse?: Course | null;
};

type LearnPageClientComponent = (props: LearnPageClientProps) => React.ReactElement;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

export function LearnHydrator(initialProps: LearnPageClientProps) {
  const [LearnPageClient, setLearnPageClient] =
    useState<LearnPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps] =
    useState<LearnPageClientProps | null>(initialProps);

  useEffect(() => {
    let isCancelled = false;

    const loadLearnApp = () => {
      if (isCancelled || LearnPageClient) {
        return;
      }

      void Promise.all([
        import("./LearnPageClient"),
        import("@/app/AuthenticatedProviders"),
      ]).then(([learnModule, providerModule]) => {
        if (!isCancelled) {
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setLearnPageClient(
            () => learnModule.default as LearnPageClientComponent,
          );
        }
      });
    };

    loadLearnApp();

    return () => {
      isCancelled = true;
    };
  }, [LearnPageClient]);

  useEffect(() => {
    if (!LearnPageClient) {
      return;
    }

    const staticView = document.querySelector("[data-learn-static]");
    staticView?.setAttribute("inert", "");
  }, [LearnPageClient]);

  if (!LearnPageClient || !AuthenticatedProviders || !hydrationProps) {
    return null;
  }

  return (
    <>
      <style>{`[data-learn-static]{display:none}`}</style>
      <AuthenticatedProviders>
        <LearnPageClient {...hydrationProps} />
      </AuthenticatedProviders>
    </>
  );
}
