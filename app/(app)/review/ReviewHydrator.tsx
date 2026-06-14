"use client";

import { useEffect, useState } from "react";
import type { ReviewInitialViewProps } from "./ReviewStaticView";

type ReviewAppComponent = (props: ReviewInitialViewProps) => React.ReactElement;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

async function loadHydrationProps(): Promise<ReviewInitialViewProps> {
  const [queueResult, statusResult, userResult] = await Promise.allSettled([
    fetch("/api/review-queue", { cache: "no-store" }),
    fetch(
      "/api/queue-status?limit=0&offset=0&mode=review&includeReviewQueue=0&includeQuestionAttempts=0&includeRecentAttempts=1&includeDeckEmbeddingPlot=0&includeQueueCounts=1",
      { cache: "no-store" },
    ),
    fetch("/api/user", { cache: "no-store" }),
  ]);

  const initialReviewSessionQueue =
    queueResult.status === "fulfilled" && queueResult.value.ok
      ? ((await queueResult.value.json()) as { items?: unknown[] }).items ?? null
      : null;
  const initialPreviousAnswerStatus =
    statusResult.status === "fulfilled" && statusResult.value.ok
      ? await statusResult.value.json()
      : null;
  const initialCurrentUser =
    userResult.status === "fulfilled" && userResult.value.ok
      ? await userResult.value.json()
      : null;

  return {
    initialCurrentUser,
    initialPreviousAnswerStatus,
    initialReviewSessionQueue: initialReviewSessionQueue as ReviewInitialViewProps["initialReviewSessionQueue"],
  };
}

export function ReviewHydrator() {
  const [ReviewApp, setReviewApp] = useState<ReviewAppComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps, setHydrationProps] =
    useState<ReviewInitialViewProps | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadReviewApp = () => {
      if (isCancelled || ReviewApp) {
        return;
      }

      void Promise.all([
        import("./ReviewApp"),
        import("@/app/AuthenticatedProviders"),
        loadHydrationProps(),
      ]).then(([reviewModule, providerModule, nextProps]) => {
        if (!isCancelled) {
          setHydrationProps(nextProps);
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setReviewApp(() => reviewModule.default as ReviewAppComponent);
        }
      });
    };

    const loadOnInteraction = () => loadReviewApp();

    window.addEventListener("pointerdown", loadOnInteraction, { once: true });
    window.addEventListener("keydown", loadOnInteraction, { once: true });
    timeoutId = globalThis.setTimeout(loadReviewApp, 4500);

    return () => {
      isCancelled = true;
      window.removeEventListener("pointerdown", loadOnInteraction);
      window.removeEventListener("keydown", loadOnInteraction);

      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, [ReviewApp]);

  useEffect(() => {
    if (!ReviewApp) {
      return;
    }

    const staticView = document.querySelector("[data-review-static]");
    staticView?.setAttribute("inert", "");
  }, [ReviewApp]);

  if (!ReviewApp || !AuthenticatedProviders || !hydrationProps) {
    return null;
  }

  return (
    <>
      <style>{`[data-review-static]{display:none}`}</style>
      <AuthenticatedProviders>
        <ReviewApp {...hydrationProps} />
      </AuthenticatedProviders>
    </>
  );
}
