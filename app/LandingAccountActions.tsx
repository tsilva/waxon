"use client";

import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { AccountWidgetsUserProfilePage } from "@/app/AccountProfileWidgets";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export function LandingAccountActions() {
  const isLocalAuth = isLocalTestAuthEnabled();

  if (isLocalAuth) {
    return (
      <div className="landing-account" aria-label="Account">
        <div className="landing-account-actions">
          <Link className="landing-account-secondary" href="/review">
            Sign in
          </Link>
          <Link className="landing-account-primary" href="/review">
            Sign up
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="landing-account" aria-label="Account">
      <Show when="signed-out">
        <div className="landing-account-actions">
          <SignInButton>
            <button className="landing-account-secondary" type="button">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton>
            <button className="landing-account-primary" type="button">
              Sign up
            </button>
          </SignUpButton>
        </div>
      </Show>
      <Show when="signed-in">
        <div className="landing-account-actions">
          <Link className="landing-account-primary" href="/review">
            Open app
          </Link>
          <UserButton
            appearance={{
              elements: {
                avatarBox: "landing-user-button-avatar",
                userButtonTrigger: "landing-user-button-trigger",
              },
            }}
          >
            <AccountWidgetsUserProfilePage />
          </UserButton>
        </div>
      </Show>
    </div>
  );
}
