"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type AuthMode = "sign-in" | "sign-up";

type ClerkProviderComponent = ComponentType<{
  afterSignOutUrl?: string;
  children: ReactNode;
  prefetchUI?: boolean;
  signInForceRedirectUrl?: string;
  signInUrl?: string;
  signUpForceRedirectUrl?: string;
  signUpUrl?: string;
}>;

type ClerkWidgetComponent = ComponentType<Record<string, never>>;

type LoadedClerkWidgets = {
  ClerkProvider: ClerkProviderComponent;
  Widget: ClerkWidgetComponent;
};

const verificationPath = "/sign-up/verify-email-address";
const postAuthReviewUrl = "/review";

const copyByMode = {
  "sign-in": {
    kicker: "Welcome back",
    title: "Sign in to waxon",
    body: "Continue to your recall queue, learning courses, and question library.",
    action: "Continue to sign in",
    loading: "Loading sign in",
  },
  "sign-up": {
    kicker: "Start practicing",
    title: "Create a waxon account",
    body: "Save your learning goal and build a durable review schedule.",
    action: "Continue to sign up",
    loading: "Loading sign up",
  },
} satisfies Record<AuthMode, Record<string, string>>;

export function AuthClerkHydrator({ mode }: { mode: AuthMode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [loadedWidgets, setLoadedWidgets] = useState<LoadedClerkWidgets | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const copy = copyByMode[mode];
  const isVerificationRoute = pathname === verificationPath;

  const restartHref = useMemo(() => {
    const redirectUrl = searchParams.get("redirect_url");

    if (!redirectUrl) {
      return "/sign-up";
    }

    const params = new URLSearchParams({ redirect_url: redirectUrl });
    return `/sign-up?${params.toString()}`;
  }, [searchParams]);

  const loadClerkWidget = useCallback(() => {
    if (loadedWidgets || isLoading) {
      return;
    }

    setIsLoading(true);
    setLoadError(false);
    void import("@clerk/nextjs")
      .then((module) => {
        setLoadedWidgets({
          ClerkProvider: module.ClerkProvider as ClerkProviderComponent,
          Widget: (mode === "sign-in"
            ? module.SignIn
            : module.SignUp) as ClerkWidgetComponent,
        });
      })
      .catch(() => {
        setLoadError(true);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isLoading, loadedWidgets, mode]);

  useEffect(() => {
    loadClerkWidget();
  }, [loadClerkWidget]);

  useEffect(() => {
    if (mode !== "sign-up" || !isVerificationRoute || !loadedWidgets) {
      setShowFallback(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      const signUpRoot = document.querySelector(
        '[data-clerk-component="SignUp"]',
      );
      const renderedText = signUpRoot?.textContent?.trim() ?? "";

      setShowFallback(renderedText.length === 0);
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [isVerificationRoute, loadedWidgets, mode]);

  const LoadedClerkProvider = loadedWidgets?.ClerkProvider;
  const LoadedWidget = loadedWidgets?.Widget;

  return (
    <>
      {!loadedWidgets ? (
        <section className="auth-static-shell" aria-labelledby="auth-static-title">
          <p className="auth-fallback-kicker">{copy.kicker}</p>
          <h1 id="auth-static-title">{copy.title}</h1>
          <p>
            {loadError
              ? "The sign-in form could not load. Try again."
              : copy.body}
          </p>
          <button
            className="auth-fallback-action"
            type="button"
            onClick={loadClerkWidget}
            aria-busy={isLoading}
            disabled={isLoading}
          >
            {loadError ? copy.action : isLoading ? copy.loading : copy.action}
          </button>
        </section>
      ) : null}

      {LoadedClerkProvider && LoadedWidget ? (
        <div className="auth-clerk-frame">
          <LoadedClerkProvider
            afterSignOutUrl="/"
            signInForceRedirectUrl={postAuthReviewUrl}
            signInUrl="/sign-in"
            signUpForceRedirectUrl={postAuthReviewUrl}
            signUpUrl="/sign-up"
          >
            <LoadedWidget />
            {showFallback ? (
              <section className="auth-fallback" aria-live="polite">
                <p className="auth-fallback-kicker">Verification paused</p>
                <h1>Restart email verification</h1>
                <p>
                  This verification page no longer has an active signup
                  attempt. Start signup again to send a fresh verification
                  email.
                </p>
                <Link className="auth-fallback-action" href={restartHref}>
                  Restart signup
                </Link>
              </section>
            ) : null}
          </LoadedClerkProvider>
        </div>
      ) : null}
    </>
  );
}
