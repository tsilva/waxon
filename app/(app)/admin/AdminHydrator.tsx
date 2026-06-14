"use client";

import { useEffect, useState } from "react";
import type { AuthenticatedUser } from "@/app/lib/auth";
import type { AdminCachedViewState } from "./adminViewStateCookie";
import type { AdminPageClient } from "./AdminPageClient";

type AdminPageClientComponent = typeof AdminPageClient;
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

type AdminHydratorProps = {
  currentUser: Pick<AuthenticatedUser, "displayName" | "email" | "avatarUrl">;
  initialViewState?: AdminCachedViewState | null;
  selectedTraceId?: string | null;
};

export function AdminHydrator({
  currentUser,
  initialViewState,
  selectedTraceId,
}: AdminHydratorProps) {
  const [LoadedAdminPageClient, setLoadedAdminPageClient] =
    useState<AdminPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);

  useEffect(() => {
    let isCancelled = false;
    const loadAdminApp = () => {
      if (isCancelled || LoadedAdminPageClient) {
        return;
      }

      void Promise.all([
        import("./AdminPageClient"),
        import("@/app/AuthenticatedProviders"),
      ]).then(([adminModule, providerModule]) => {
        if (!isCancelled) {
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setLoadedAdminPageClient(
            () => adminModule.AdminPageClient as AdminPageClientComponent,
          );
        }
      });
    };

    const loadOnInteraction = () => loadAdminApp();

    window.addEventListener("pointerdown", loadOnInteraction, { once: true });
    window.addEventListener("keydown", loadOnInteraction, { once: true });

    return () => {
      isCancelled = true;
      window.removeEventListener("pointerdown", loadOnInteraction);
      window.removeEventListener("keydown", loadOnInteraction);
    };
  }, [LoadedAdminPageClient]);

  useEffect(() => {
    if (!LoadedAdminPageClient) {
      return;
    }

    const staticView = document.querySelector("[data-admin-static]");
    staticView?.setAttribute("inert", "");
  }, [LoadedAdminPageClient]);

  if (!LoadedAdminPageClient || !AuthenticatedProviders) {
    return null;
  }

  return (
    <>
      <style>{`[data-admin-static]{display:none}`}</style>
      <AuthenticatedProviders>
        <LoadedAdminPageClient
          currentUser={currentUser}
          initialInteractions={[]}
          initialDueCount={0}
          initialViewState={initialViewState}
          selectedTraceId={selectedTraceId}
        />
      </AuthenticatedProviders>
    </>
  );
}
