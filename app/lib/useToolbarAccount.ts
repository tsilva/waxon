"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useMemo } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

type ToolbarAccountUser = {
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
};

export function useToolbarAccount(
  currentUser?: ToolbarAccountUser | null,
  options: {
    fallbackDisplayName?: string;
    localManageHref?: string;
    localSignOutHref?: string;
    onLocalManageAccount?: () => void;
    showAdmin?: boolean;
  } = {},
) {
  const clerk = useClerk();
  const { user: clerkUser } = useUser();
  const isLocalAuth = isLocalTestAuthEnabled();
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const menuAvatarUrl = clerkUser?.imageUrl || currentUser?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    currentUser?.displayName ||
    options.fallbackDisplayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email || "";
  const canViewAdmin = Boolean(options.showAdmin) || isAdminEmail(menuEmail);

  return {
    canViewAdmin,
    menuAvatarUrl,
    menuDisplayName,
    menuEmail,
    onManageAccount() {
      if (isLocalAuth) {
        if (options.onLocalManageAccount) {
          options.onLocalManageAccount();
        } else if (options.localManageHref) {
          window.location.assign(options.localManageHref);
        }
        return;
      }

      clerk.openUserProfile({
        customPages: accountWidgetsCustomPages,
      });
    },
    onSignOut() {
      if (isLocalAuth) {
        if (options.localSignOutHref) {
          window.location.assign(options.localSignOutHref);
        }
        return;
      }

      void clerk.signOut({ redirectUrl: "/" });
    },
  };
}
