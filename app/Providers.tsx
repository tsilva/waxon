"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

const routesWithoutAuthShell = new Set(["/"]);
const AuthShell = dynamic(() =>
  import("./AuthShell").then((mod) => mod.AuthShell),
);

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (routesWithoutAuthShell.has(pathname)) {
    return children;
  }

  return <AuthShell>{children}</AuthShell>;
}
