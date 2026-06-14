"use client";

import { ClerkProvider } from "@clerk/nextjs";

const postAuthReviewUrl = "/review";

export function ClerkAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      prefetchUI={false}
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      {children}
    </ClerkProvider>
  );
}
