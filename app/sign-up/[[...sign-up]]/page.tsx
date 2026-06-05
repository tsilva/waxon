import { redirect } from "next/navigation";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { SignUpWithFallback } from "./SignUpWithFallback";

export default function SignUpPage() {
  if (isLocalTestAuthEnabled()) {
    redirect("/review");
  }

  return (
    <main className="auth-page">
      <SignUpWithFallback />
    </main>
  );
}
