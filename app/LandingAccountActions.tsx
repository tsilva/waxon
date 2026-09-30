import Link from "next/link";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

export function LandingAccountActions() {
  const isLocalAuth = isLocalTestAuthEnabled();

  return (
    <div className="landing-account">
      <Link
        className="landing-sign-in"
        href={isLocalAuth ? "/review" : "/sign-in"}
        prefetch={false}
      >
        Sign in
      </Link>
    </div>
  );
}
