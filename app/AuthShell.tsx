"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { AuthBar } from "./AuthBar";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <AuthBar />
      {children}
    </ClerkProvider>
  );
}
