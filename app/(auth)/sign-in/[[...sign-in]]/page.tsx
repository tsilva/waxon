import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
      <SignIn />
    </main>
  );
}
