import { ClerkAuthProvider } from "./ClerkAuthProvider";
import "./auth-globals.css";

export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <ClerkAuthProvider>{children}</ClerkAuthProvider>;
}
