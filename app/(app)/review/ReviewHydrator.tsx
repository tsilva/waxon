"use client";

import { useEffect, useState } from "react";
import type { ReviewInitialViewProps } from "./ReviewStaticView";

type ReviewAppComponent = (props: ReviewInitialViewProps) => React.ReactElement;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

export function ReviewHydrator(initialProps: ReviewInitialViewProps) {
  const [ReviewApp, setReviewApp] = useState<ReviewAppComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps] =
    useState<ReviewInitialViewProps | null>(initialProps);

  useEffect(() => {
    let isCancelled = false;

    const loadReviewApp = () => {
      if (isCancelled || ReviewApp) {
        return;
      }

      void Promise.all([
        import("./ReviewApp"),
        import("@/app/AuthenticatedProviders"),
      ]).then(([reviewModule, providerModule]) => {
        if (!isCancelled) {
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setReviewApp(() => reviewModule.default as ReviewAppComponent);
        }
      });
    };

    loadReviewApp();

    return () => {
      isCancelled = true;
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
