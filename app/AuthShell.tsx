"use client";

import { ClerkProvider, useAuth, useClerk } from "@clerk/nextjs";
import { useEffect } from "react";
import { AuthBar } from "./AuthBar";
import { isLocalTestAuthEnabled } from "./lib/localTestAuth";
import { LocalClerkProvider } from "./LocalClerkProvider";

const postAuthReviewUrl = "/review";

function ClientAuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();

  useEffect(() => {
    if (!isLoaded || isSignedIn) {
      return;
    }

    void clerk.redirectToSignIn();
  }, [clerk, isLoaded, isSignedIn]);

  return (
    <>
      <AuthBar />
      {children}
    </>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  if (isLocalTestAuthEnabled()) {
    return (
      <LocalClerkProvider>
        <ClientAuthGate>{children}</ClientAuthGate>
      </LocalClerkProvider>
    );
  }

  return (
    <ClerkProvider
      prefetchUI={false}
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      <ClientAuthGate>{children}</ClientAuthGate>
    </ClerkProvider>
  );
}
