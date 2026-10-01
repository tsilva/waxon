"use client";

import { ClerkProvider, useAuth, useClerk } from "@clerk/nextjs";
import { useCallback, useEffect } from "react";
import { AuthBar } from "./AuthBar";
import { isLocalTestAuthEnabled } from "./lib/localTestAuth";
import { LocalClerkProvider } from "./LocalClerkProvider";

const postAuthReviewUrl = "/review";

type ClientAuthGateViewProps = {
  children?: React.ReactNode;
  fallback?: React.ReactNode;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  redirectToSignIn: () => void | Promise<unknown>;
};

export function ClientAuthGateView({
  children,
  fallback,
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
    return fallback ?? null;
  }

  return (
    <>
      <AuthBar />
      {children}
    </>
  );
}

type AuthShellProps = {
  children: React.ReactNode;
  fallback?: React.ReactNode;
};

function ClientAuthGate({ children, fallback }: AuthShellProps) {
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
      fallback={fallback}
    >
      {children}
    </ClientAuthGateView>
  );
}

export function AuthShell({ children, fallback }: AuthShellProps) {
  if (isLocalTestAuthEnabled()) {
    return (
      <LocalClerkProvider>
        <ClientAuthGate fallback={fallback}>{children}</ClientAuthGate>
      </LocalClerkProvider>
    );
  }

  return (
    <ClerkProvider
      signInForceRedirectUrl={postAuthReviewUrl}
      signUpForceRedirectUrl={postAuthReviewUrl}
    >
      <ClientAuthGate fallback={fallback}>{children}</ClientAuthGate>
    </ClerkProvider>
  );
}
