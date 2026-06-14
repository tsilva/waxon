"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const AuthenticatedProviders = dynamic(
  () =>
    import("./AuthenticatedProviders").then(
      (module) => module.AuthenticatedProviders,
    ),
  { ssr: false },
);

const publicRoutes = new Set(["/", "/privacy-policy", "/terms-and-conditions"]);

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (publicRoutes.has(pathname)) {
    return children;
  }

  return (
    <AuthenticatedProviders>
      {children}
    </AuthenticatedProviders>
  );
}
