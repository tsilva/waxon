"use client";

import { useEffect, useState } from "react";
import type { Course, UserProfile } from "./LearnPageClient";

type LearnPageClientProps = {
  initialCourseId?: string;
  initialCourses?: Course[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number;
  initialSelectedCourse?: Course | null;
};

type LearnPageClientComponent = (props: LearnPageClientProps) => React.ReactElement;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

async function loadLearnHydrationProps(
  initialCourseId?: string,
): Promise<LearnPageClientProps> {
  const courseRequest = initialCourseId
    ? fetch(`/api/courses/${encodeURIComponent(initialCourseId)}`, {
        cache: "no-store",
      })
    : Promise.resolve(null);
  const [coursesResult, userResult, queueResult, courseResult] =
    await Promise.allSettled([
      fetch("/api/courses", { cache: "no-store" }),
      fetch("/api/user", { cache: "no-store" }),
      fetch(
        "/api/queue-status?mode=review&includeReviewQueue=0&includeRecentAttempts=0&includeQuestionAttempts=0&includeDeckEmbeddingPlot=0&includeQueueCounts=1",
        { cache: "no-store" },
      ),
      courseRequest,
    ]);

  const initialCourses =
    coursesResult.status === "fulfilled" && coursesResult.value.ok
      ? ((await coursesResult.value.json()) as { courses?: Course[] }).courses ?? null
      : null;
  const initialCurrentUser =
    userResult.status === "fulfilled" && userResult.value.ok
      ? ((await userResult.value.json()) as UserProfile)
      : null;
  const queueData =
    queueResult.status === "fulfilled" && queueResult.value.ok
      ? ((await queueResult.value.json()) as { queueRemaining?: number })
      : null;
  const initialSelectedCourse =
    courseResult.status === "fulfilled" && courseResult.value?.ok
      ? ((await courseResult.value.json()) as { course?: Course }).course ?? null
      : null;

  return {
    initialCourseId,
    initialCourses,
    initialCurrentUser,
    initialDueCount: queueData?.queueRemaining ?? 0,
    initialSelectedCourse,
  };
}

export function LearnHydrator({ initialCourseId }: { initialCourseId?: string }) {
  const [LearnPageClient, setLearnPageClient] =
    useState<LearnPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps, setHydrationProps] =
    useState<LearnPageClientProps | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadLearnApp = () => {
      if (isCancelled || LearnPageClient) {
        return;
      }

      void Promise.all([
        import("./LearnPageClient"),
        import("@/app/AuthenticatedProviders"),
        loadLearnHydrationProps(initialCourseId),
      ]).then(([learnModule, providerModule, nextProps]) => {
        if (!isCancelled) {
          setHydrationProps(nextProps);
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

    const loadOnInteraction = () => loadLearnApp();

    window.addEventListener("pointerdown", loadOnInteraction, { once: true });
    window.addEventListener("keydown", loadOnInteraction, { once: true });
    timeoutId = globalThis.setTimeout(loadLearnApp, 4500);

    return () => {
      isCancelled = true;
      window.removeEventListener("pointerdown", loadOnInteraction);
      window.removeEventListener("keydown", loadOnInteraction);

      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, [LearnPageClient, initialCourseId]);

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
