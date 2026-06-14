"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { useMemo, type ComponentType, type ReactNode } from "react";
import { localTestUser } from "@/app/lib/localTestAuth";

const localClerkUser = {
  id: localTestUser.id,
  imageUrl: localTestUser.avatarUrl,
  fullName: localTestUser.displayName,
  username: "eng.tiago.silva",
  primaryEmailAddress: {
    emailAddress: localTestUser.email,
  },
  organizationMemberships: [],
} as const;

const localClerkResources = {
  client: null,
  session: {
    id: "local-test-session",
    status: "active",
    lastActiveToken: { jwt: { claims: {} } },
    factorVerificationAge: null,
    actor: null,
  },
  user: localClerkUser,
  organization: null,
};

type LocalClerkListener = (resources: typeof localClerkResources) => void;

function createLocalClerk() {
  const listeners = new Set<LocalClerkListener>();

  return {
    loaded: true,
    status: "ready",
    isSignedIn: true,
    user: localClerkUser,
    session: localClerkResources.session,
    client: localClerkResources.client,
    organization: localClerkResources.organization,
    __internal_lastEmittedResources: localClerkResources,
    telemetry: {
      record() {},
    },
    load: async () => {},
    addListener(listener: LocalClerkListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    on(event: string, listener: (status: string) => void) {
      if (event === "status") {
        listener("ready");
      }

      return () => {};
    },
    off() {},
    openUserProfile() {},
    closeUserProfile() {},
    signOut({ redirectUrl = "/" }: { redirectUrl?: string } = {}) {
      window.location.assign(redirectUrl);
      return Promise.resolve();
    },
    __internal_getOption() {
      return undefined;
    },
    __internal_updateProps() {
      return Promise.resolve();
    },
  };
}

const LocalAuditClerkProvider = ClerkProvider as ComponentType<{
  children: ReactNode;
  Clerk: unknown;
  publishableKey: string;
  prefetchUI: false;
  standardBrowser: false;
  __internal_scriptsSlot: ReactNode;
}>;

export function LocalClerkProvider({
  children,
}: {
  children: ReactNode;
}) {
  const localClerk = useMemo(() => createLocalClerk(), []);

  return (
    <LocalAuditClerkProvider
      Clerk={localClerk}
      publishableKey={
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
        "pk_test_bG9jYWwtd2F4b24kbG9jYWwuY2xlcmsk"
      }
      prefetchUI={false}
      standardBrowser={false}
      __internal_scriptsSlot={<></>}
    >
      {children}
    </LocalAuditClerkProvider>
  );
}
