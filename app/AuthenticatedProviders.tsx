"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppViewCacheProvider, useAppViewCache } from "./AppViewCache";
import { AppErrorProvider } from "./AppErrorModal";
import { AuthShell } from "./AuthShell";
import { LocalAccountSettings } from "./LocalAccountSettings";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";
import { ToolbarStateProvider, useToolbarState } from "./ToolbarState";

function AdminViewPreloader() {
  const pathname = usePathname();
  const router = useRouter();
  const viewCache = useAppViewCache();
  const { canViewAdmin } = useToolbarState();
  const shouldPreload =
    canViewAdmin &&
    (pathname.startsWith("/review") || pathname.startsWith("/library"));

  useEffect(() => {
    if (!shouldPreload) {
      return;
    }

    router.prefetch("/admin");
    void import("./(app)/admin/AdminHydrator")
      .then(({ AdminHydrator }) => AdminHydrator.preload())
      .catch(() => {
        // Preloading is opportunistic; navigation can load the client normally.
      });
    void viewCache.preloadAdmin();
  }, [router, shouldPreload, viewCache]);

  return null;
}

export function AuthenticatedProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isLocalAccountSettingsOpen, setIsLocalAccountSettingsOpen] =
    useState(false);
  const closeLocalAccountSettings = useCallback(
    () => setIsLocalAccountSettingsOpen(false),
    [],
  );

  return (
    <AuthShell>
      <AppErrorProvider>
        <ToolbarStateProvider>
          <AppViewCacheProvider>
            <AdminViewPreloader />
            <PersistentReviewToolbarActions
              onManageLocalAccount={() => setIsLocalAccountSettingsOpen(true)}
            />
            {children}
            <LocalAccountSettings
              isOpen={isLocalAccountSettingsOpen}
              onClose={closeLocalAccountSettings}
            />
          </AppViewCacheProvider>
        </ToolbarStateProvider>
      </AppErrorProvider>
    </AuthShell>
  );
}
