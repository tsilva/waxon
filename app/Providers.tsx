"use client";

import { AuthShell } from "./AuthShell";

export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
