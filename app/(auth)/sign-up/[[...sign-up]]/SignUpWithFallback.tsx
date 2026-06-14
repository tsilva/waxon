"use client";

import { SignUp } from "@clerk/nextjs";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const verificationPath = "/sign-up/verify-email-address";

export function SignUpWithFallback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showFallback, setShowFallback] = useState(false);
  const isVerificationRoute = pathname === verificationPath;

  const restartHref = useMemo(() => {
    const redirectUrl = searchParams.get("redirect_url");

    if (!redirectUrl) {
      return "/sign-up";
    }

    const params = new URLSearchParams({ redirect_url: redirectUrl });
    return `/sign-up?${params.toString()}`;
  }, [searchParams]);

  useEffect(() => {
    if (!isVerificationRoute) {
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
  }, [isVerificationRoute]);

  return (
    <>
      <SignUp />
      {showFallback ? (
        <section className="auth-fallback" aria-live="polite">
          <p className="auth-fallback-kicker">Verification paused</p>
          <h1>Restart email verification</h1>
          <p>
            This verification page no longer has an active signup attempt.
            Start signup again to send a fresh verification email.
          </p>
          <Link className="auth-fallback-action" href={restartHref}>
            <RotateCcw aria-hidden="true" />
            Restart signup
          </Link>
        </section>
      ) : null}
    </>
  );
}
