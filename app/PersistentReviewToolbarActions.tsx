"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import { ReviewToolbarActions } from "@/app/ReviewToolbar";
import { reviewToolbarTabFromPathname } from "@/app/toolbarTypes";
import { useToolbarState } from "@/app/ToolbarState";

const toolbarRoutes = [
  "/review",
  "/library",
  "/stats",
  "/admin",
];
export function PersistentReviewToolbarActions({
  onManageLocalAccount,
}: {
  onManageLocalAccount: () => void;
}) {
  const pathname = usePathname();
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

  const activeTab = reviewToolbarTabFromPathname(pathname);
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
          onManageLocalAccount();
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
