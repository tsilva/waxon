import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthClerkHydrator } from "../../AuthClerkHydrator";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export const metadata: Metadata = {
  title: "Sign up - waxon",
  description: "Create a waxon account to start free-text recall practice.",
};

export default function SignUpPage() {
  if (isLocalTestAuthEnabled()) {
    redirect("/review");
  }

  return (
    <main className="auth-page">
      <AuthClerkHydrator mode="sign-up" />
    </main>
  );
}
