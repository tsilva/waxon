"use client";

import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountWidgetsUserProfilePage } from "@/app/AccountProfileWidgets";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

const authRoutes = ["/sign-in", "/sign-up"];
const reviewShellRoutes = ["/review", "/queue", "/decks", "/admin"];

export function AuthBar() {
  const pathname = usePathname();
  const isLocalAuth = isLocalTestAuthEnabled();
  const isLandingRoute = pathname === "/";
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));
  const isReviewShellRoute = reviewShellRoutes.some((route) =>
    pathname.startsWith(route),
  );

  if (isLandingRoute || isAuthRoute || isReviewShellRoute) {
    return null;
  }

  return (
    <header className="auth-bar" aria-label="Account">
      {isLocalAuth ? (
        <div className="auth-actions">
          <Link className="auth-action" href="/review">
            Sign in
          </Link>
          <Link className="auth-action auth-action-primary" href="/review">
            Sign up
          </Link>
        </div>
      ) : (
        <>
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
            <UserButton>
              <AccountWidgetsUserProfilePage />
            </UserButton>
          </Show>
        </>
      )}
    </header>
  );
}
