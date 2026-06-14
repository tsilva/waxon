import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthClerkHydrator } from "../../AuthClerkHydrator";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export const metadata: Metadata = {
  title: "Sign in - waxon",
  description: "Sign in to continue practicing recall with waxon.",
};

export default function SignInPage() {
  if (isLocalTestAuthEnabled()) {
    redirect("/review");
  }

  return (
    <main className="auth-page">
      <AuthClerkHydrator mode="sign-in" />
    </main>
  );
}
