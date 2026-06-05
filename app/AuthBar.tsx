"use client";

import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { usePathname } from "next/navigation";

const authRoutes = ["/sign-in", "/sign-up"];
const reviewShellRoutes = ["/review", "/queue"];

export function AuthBar() {
  const pathname = usePathname();
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));
  const isReviewShellRoute = reviewShellRoutes.some((route) =>
    pathname.startsWith(route),
  );

  if (isAuthRoute || isReviewShellRoute) {
    return null;
  }

  return (
    <header className="auth-bar" aria-label="Account">
      <Show when="signed-out">
        <div className="auth-actions">
          <SignInButton>
            <button className="auth-action" type="button">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton>
            <button className="auth-action auth-action-primary" type="button">
              Sign up
            </button>
          </SignUpButton>
        </div>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </header>
  );
}
