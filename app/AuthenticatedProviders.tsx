"use client";

import { useCallback, useState } from "react";
import { AppViewCacheProvider } from "./AppViewCache";
import { AppErrorProvider } from "./AppErrorModal";
import { AuthShell } from "./AuthShell";
import { LocalAccountSettings } from "./LocalAccountSettings";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";
import { ToolbarStateProvider } from "./ToolbarState";

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
