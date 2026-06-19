"use client";

import { AuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
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

function loadAdminPageClient(): Promise<AdminPageClientComponent> {
  return import("./AdminPageClient").then(
    (adminModule) => adminModule.AdminPageClient as AdminPageClientComponent,
  );
}

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

  return (
    <AuthenticatedClientHydrator
      componentProps={componentProps}
      loadClient={loadAdminPageClient}
      staticSelector="[data-admin-static]"
    />
  );
}
