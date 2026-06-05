import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

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
