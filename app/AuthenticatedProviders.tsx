"use client";

import { AuthShell } from "./AuthShell";

export function AuthenticatedProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthShell>{children}</AuthShell>;
}
