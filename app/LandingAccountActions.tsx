import Link from "next/link";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export function LandingAccountActions() {
  const isLocalAuth = isLocalTestAuthEnabled();

  if (!isLocalAuth) {
    return <div className="landing-account" />;
  }

  return (
    <div className="landing-account">
      <div className="landing-account-actions">
        <Link className="landing-account-secondary" href="/review">
          Sign in
        </Link>
        <Link className="landing-account-primary" href="/review">
          Sign up
        </Link>
      </div>
    </div>
  );
}
