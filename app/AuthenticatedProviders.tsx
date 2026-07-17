"use client";

import { AppErrorProvider } from "./AppErrorModal";
import { AuthShell } from "./AuthShell";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";
import { ToolbarStateProvider } from "./ToolbarState";

export function AuthenticatedProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthShell>
      <AppErrorProvider>
        <ToolbarStateProvider>
          <PersistentReviewToolbarActions />
          {children}
        </ToolbarStateProvider>
      </AppErrorProvider>
    </AuthShell>
  );
}
