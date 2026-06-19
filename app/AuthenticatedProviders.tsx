"use client";

import { AppErrorProvider } from "./AppErrorModal";
import { AuthShell } from "./AuthShell";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";

export function AuthenticatedProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthShell>
      <AppErrorProvider>
        <PersistentReviewToolbarActions />
        {children}
      </AppErrorProvider>
    </AuthShell>
  );
}
