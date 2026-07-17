"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { AdminCachedViewState } from "./adminViewStateCookie";
import type { AdminPageClient } from "./AdminPageClient";

type AdminPageClientComponent = typeof AdminPageClient;

type AdminHydratorProps = {
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
  initialViewState,
  selectedTraceId,
}: AdminHydratorProps) {
  const componentProps: AdminPageClientProps = {
    initialInteractions: [],
    initialViewState,
    selectedTraceId,
  };

  return <AdminPageClientHydrator {...componentProps} />;
}
