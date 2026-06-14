"use client";

import type { ReactNode } from "react";
import { localTestUser } from "@/app/lib/localTestAuth";

const localUser = {
  id: localTestUser.id,
  imageUrl: localTestUser.avatarUrl,
  fullName: localTestUser.displayName,
  username: "eng.tiago.silva",
  primaryEmailAddress: {
    emailAddress: localTestUser.email,
  },
  organizationMemberships: [],
} as const;

type ChildrenProps = {
  children?: ReactNode;
};

function Passthrough({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function ClerkProvider({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function Show({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function SignInButton({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function SignUpButton({ children }: ChildrenProps) {
  return <>{children}</>;
}

export const UserButton = Object.assign(Passthrough, {
  UserProfilePage: Passthrough,
});

export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}

export function useClerk() {
  return {
    loaded: true,
    isSignedIn: true,
    openUserProfile() {},
    signOut({ redirectUrl = "/" }: { redirectUrl?: string } = {}) {
      window.location.assign(redirectUrl);
      return Promise.resolve();
    },
  };
}

export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: localUser,
  };
}
