"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { ReviewToolbarActions } from "@/app/ReviewToolbar";
import { localSettingsEvent } from "@/app/toolbarEvents";
import type { ReviewToolbarTab } from "@/app/toolbarTypes";
import { useToolbarState } from "@/app/ToolbarState";

const toolbarRoutes = [
  "/review",
  "/library",
  "/stats",
  "/admin",
];
function activeTabFromPathname(pathname: string): ReviewToolbarTab {
  if (pathname.startsWith("/library")) {
    return "library";
  }

  if (pathname.startsWith("/stats")) {
    return "stats";
  }

  if (pathname.startsWith("/admin")) {
    return "admin";
  }

  return "review";
}

export function PersistentReviewToolbarActions() {
  const pathname = usePathname();
  const router = useRouter();
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const { currentUser, dueCount } = useToolbarState();
  const isLocalAuth = isLocalTestAuthEnabled();
  const isToolbarRoute = toolbarRoutes.some((route) =>
    pathname.startsWith(route),
  );
  if (!isToolbarRoute) {
    return null;
  }

  const activeTab = activeTabFromPathname(pathname);
  const menuAvatarUrl =
    clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress ||
    currentUser?.email ||
    "";
  const canViewAdmin = isAdminEmail(
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email,
  );

  if (activeTab === "admin" && !canViewAdmin) {
    return null;
  }

  return (
    <ReviewToolbarActions
      className="persistent-toolbar-actions"
      activeTab={activeTab}
      dueCount={dueCount}
      menuAvatarUrl={menuAvatarUrl}
      menuDisplayName={menuDisplayName}
      menuEmail={menuEmail}
      onManageAccount={() => {
        if (isLocalAuth) {
          if (pathname.startsWith("/review")) {
            window.dispatchEvent(new Event(localSettingsEvent));
          } else {
            router.push("/review");
          }

          return;
        }

        clerk.openUserProfile();
      }}
      onSignOut={() => {
        if (isLocalAuth) {
          window.location.assign("/");
        } else {
          void clerk.signOut({ redirectUrl: "/" });
        }
      }}
    />
  );
}
