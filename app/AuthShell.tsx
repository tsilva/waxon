"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { AuthBar } from "./AuthBar";
import { isLocalTestAuthEnabled } from "./lib/localTestAuth";
import { LocalClerkProvider } from "./LocalClerkProvider";

const postAuthReviewUrl = "/review";

export function AuthShell({ children }: { children: React.ReactNode }) {
  if (isLocalTestAuthEnabled()) {
    return (
      <LocalClerkProvider>
        <AuthBar />
        {children}
      </LocalClerkProvider>
    );
  }

  return (
    <ClerkProvider
      prefetchUI={false}
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      <AuthBar />
      {children}
    </ClerkProvider>
  );
}
