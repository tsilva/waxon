"use client";

import { AuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { ReviewInitialViewProps } from "./ReviewStaticView";

type ReviewAppComponent = (props: ReviewInitialViewProps) => React.ReactElement;

function loadReviewApp(): Promise<ReviewAppComponent> {
  return import("./ReviewApp").then(
    (reviewModule) => reviewModule.default as ReviewAppComponent,
  );
}

export function ReviewHydrator(initialProps: ReviewInitialViewProps) {
  return (
    <AuthenticatedClientHydrator
      componentProps={initialProps}
      loadClient={loadReviewApp}
      staticSelector="[data-review-static]"
    />
  );
}
