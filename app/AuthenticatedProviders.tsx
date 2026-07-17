"use client";

import { useCallback, useState } from "react";
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
          <PersistentReviewToolbarActions
            onManageLocalAccount={() => setIsLocalAccountSettingsOpen(true)}
          />
          {children}
          <LocalAccountSettings
            isOpen={isLocalAccountSettingsOpen}
            onClose={closeLocalAccountSettings}
          />
        </ToolbarStateProvider>
      </AppErrorProvider>
    </AuthShell>
  );
}
