"use client";

import Link from "next/link";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export function LandingAccountActions() {
  const isLocalAuth = isLocalTestAuthEnabled();
  const signInHref = isLocalAuth ? "/review" : "/sign-in";
  const signUpHref = isLocalAuth ? "/review" : "/sign-up";

  return (
    <div className="landing-account" aria-label="Account">
      <div className="landing-account-actions">
        <Link className="landing-account-secondary" href={signInHref}>
          Sign in
        </Link>
        <Link className="landing-account-primary" href={signUpHref}>
          Sign up
        </Link>
      </div>
    </div>
  );
}
