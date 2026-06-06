"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { AuthBar } from "./AuthBar";

const postAuthReviewUrl = "/review";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      <AuthBar />
      {children}
    </ClerkProvider>
  );
}
