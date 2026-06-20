"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { AuthenticatedUser } from "@/app/lib/auth";
import type { AdminCachedViewState } from "./adminViewStateCookie";
import type { AdminPageClient } from "./AdminPageClient";

type AdminPageClientComponent = typeof AdminPageClient;

type AdminHydratorProps = {
  currentUser: Pick<AuthenticatedUser, "displayName" | "email" | "avatarUrl">;
  initialViewState?: AdminCachedViewState | null;
  selectedTraceId?: string | null;
};

type AdminPageClientProps = Parameters<AdminPageClientComponent>[0];

const AdminPageClientHydrator =
  createAuthenticatedClientHydrator<AdminPageClientProps>({
    loadClient: () =>
      import("./AdminPageClient").then(
        (module) => module.AdminPageClient as AdminPageClientComponent,
      ),
    staticSelector: "[data-admin-static]",
  });

export function AdminHydrator({
  currentUser,
  initialViewState,
  selectedTraceId,
}: AdminHydratorProps) {
  const componentProps: AdminPageClientProps = {
    currentUser,
    initialInteractions: [],
    initialDueCount: 0,
    initialViewState,
    selectedTraceId,
  };

  return <AdminPageClientHydrator {...componentProps} />;
}
