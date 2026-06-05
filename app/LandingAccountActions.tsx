"use client";

import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function LandingAccountActions() {
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
          />
        </div>
      </Show>
    </div>
  );
}
