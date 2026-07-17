import "./app-globals.css";
import { AuthenticatedProviders } from "@/app/AuthenticatedProviders";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AuthenticatedProviders>{children}</AuthenticatedProviders>;
}
