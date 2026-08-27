"use client";

import { ClerkProvider, useAuth, useClerk } from "@clerk/nextjs";
import { useCallback, useEffect } from "react";
import { AuthBar } from "./AuthBar";
import { isLocalTestAuthEnabled } from "./lib/localTestAuth";
import { LocalClerkProvider } from "./LocalClerkProvider";

const postAuthReviewUrl = "/review";

type ClientAuthGateViewProps = {
  children?: React.ReactNode;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  redirectToSignIn: () => void | Promise<unknown>;
};

export function ClientAuthGateView({
  children,
  isLoaded,
  isSignedIn,
  redirectToSignIn,
}: ClientAuthGateViewProps) {
  useEffect(() => {
    if (!isLoaded || isSignedIn) {
      return;
    }

    void redirectToSignIn();
  }, [isLoaded, isSignedIn, redirectToSignIn]);

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  return (
    <>
      <AuthBar />
      {children}
    </>
  );
}

function ClientAuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const redirectToSignIn = useCallback(
    () => clerk.redirectToSignIn(),
    [clerk],
  );

  return (
    <ClientAuthGateView
      isLoaded={isLoaded}
      isSignedIn={isSignedIn}
      redirectToSignIn={redirectToSignIn}
    >
      {children}
    </ClientAuthGateView>
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
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      <ClientAuthGate>{children}</ClientAuthGate>
    </ClerkProvider>
  );
}
