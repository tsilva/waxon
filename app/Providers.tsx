"use client";

import { AuthShell } from "./AuthShell";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell>
      <PersistentReviewToolbarActions />
      {children}
    </AuthShell>
  );
}
