"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAccountWidgetsCustomPages } from "@/app/AccountProfileWidgets";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";
import {
  ReviewToolbarActions,
  type ReviewToolbarTab,
} from "@/app/ReviewToolbar";
import {
  localSettingsEvent,
  toolbarDueCountEvent,
  toolbarSnapshotEvent,
  type ToolbarDueCountDetail,
  type ToolbarSnapshotDetail,
} from "@/app/toolbarEvents";

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type QueueStatusResponse = {
  queueRemaining?: number;
};

type CachedToolbarData = {
  dueCount: number;
  user: UserProfileResponse | null;
};

const toolbarRoutes = [
  "/learn",
  "/review",
  "/library",
  "/tags",
  "/stats",
  "/admin",
];
const cacheKey = "waxon-toolbar-actions";

function readCachedToolbarData(): CachedToolbarData {
  if (typeof window === "undefined") {
    return { dueCount: 0, user: null };
  }

  try {
    const cached = window.sessionStorage.getItem(cacheKey);

    if (!cached) {
      return { dueCount: 0, user: null };
    }

    const parsed = JSON.parse(cached) as Partial<CachedToolbarData>;

    return {
      dueCount: Number.isFinite(parsed.dueCount) ? Number(parsed.dueCount) : 0,
      user: parsed.user ?? null,
    };
  } catch {
    return { dueCount: 0, user: null };
  }
}

function writeCachedToolbarData(data: CachedToolbarData) {
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(data));
  } catch {
    // The cache only prevents a route-change flash; failure is harmless.
  }
}

function activeTabFromPathname(pathname: string): ReviewToolbarTab {
  if (pathname.startsWith("/learn")) {
    return "learn";
  }

  if (pathname.startsWith("/library")) {
    return "library";
  }

  if (pathname.startsWith("/tags")) {
    return "tags";
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
  const accountWidgetsCustomPages = useMemo(
    () => createAccountWidgetsCustomPages(),
    [],
  );
  const isLocalAuth = isLocalTestAuthEnabled();
  const isToolbarRoute = toolbarRoutes.some((route) =>
    pathname.startsWith(route),
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [toolbarData, setToolbarData] = useState<CachedToolbarData>({
    dueCount: 0,
    user: null,
  });
  const hasLoadedToolbarDataRef = useRef(false);

  useEffect(() => {
    setToolbarData(readCachedToolbarData());
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    function handleToolbarSnapshot(event: Event) {
      const snapshot = (event as CustomEvent<ToolbarSnapshotDetail>).detail;

      if (!snapshot) {
        return;
      }

      setToolbarData((current) => {
        const nextData = {
          dueCount: current.dueCount,
          user: {
            id: current.user?.id ?? "toolbar",
            displayName: snapshot.menuDisplayName,
            email: snapshot.menuEmail,
            avatarUrl: snapshot.menuAvatarUrl,
          },
        };

        writeCachedToolbarData(nextData);

        return nextData;
      });
    }

    window.addEventListener(toolbarSnapshotEvent, handleToolbarSnapshot);

    return () =>
      window.removeEventListener(toolbarSnapshotEvent, handleToolbarSnapshot);
  }, []);

  useEffect(() => {
    function handleToolbarDueCount(event: Event) {
      const detail = (event as CustomEvent<ToolbarDueCountDetail>).detail;
      const nextDueCount = Number(detail?.dueCount);

      if (!Number.isFinite(nextDueCount)) {
        return;
      }

      setToolbarData((current) => {
        const nextData = {
          ...current,
          dueCount: nextDueCount,
        };

        writeCachedToolbarData(nextData);

        return nextData;
      });
    }

    window.addEventListener(toolbarDueCountEvent, handleToolbarDueCount);

    return () =>
      window.removeEventListener(toolbarDueCountEvent, handleToolbarDueCount);
  }, []);

  const loadToolbarData = useCallback(async (signal: AbortSignal) => {
    const [queueResult, userResult] = await Promise.allSettled([
      fetch("/api/queue-status?mode=review&includeReviewQueue=0", {
        cache: "no-store",
        signal,
      }),
      fetch("/api/user", {
        cache: "no-store",
        signal,
      }),
    ]);

    if (signal.aborted) {
      return;
    }

    let loadedDueCount: number | null = null;
    let loadedUser: UserProfileResponse | null = null;

    if (queueResult.status === "fulfilled" && queueResult.value.ok) {
      const queueData =
        (await queueResult.value.json()) as QueueStatusResponse;

      if (Number.isFinite(queueData.queueRemaining)) {
        loadedDueCount = Number(queueData.queueRemaining);
      }
    }

    if (userResult.status === "fulfilled" && userResult.value.ok) {
      loadedUser = (await userResult.value.json()) as UserProfileResponse;
    }

    setToolbarData((current) => {
      const nextData = {
        dueCount: loadedDueCount ?? current.dueCount,
        user: loadedUser ?? current.user,
      };

      writeCachedToolbarData(nextData);

      return nextData;
    });
  }, []);

  useEffect(() => {
    if (!isToolbarRoute || hasLoadedToolbarDataRef.current) {
      return;
    }

    const controller = new AbortController();

    hasLoadedToolbarDataRef.current = true;
    void loadToolbarData(controller.signal);

    return () => controller.abort();
  }, [isToolbarRoute, loadToolbarData]);

  if (!hasHydrated || !isToolbarRoute) {
    return null;
  }

  const activeTab = activeTabFromPathname(pathname);
  const menuAvatarUrl =
    clerkUser?.imageUrl || toolbarData.user?.avatarUrl || null;
  const menuDisplayName =
    clerkUser?.fullName ||
    clerkUser?.username ||
    toolbarData.user?.displayName ||
    "Account";
  const menuEmail =
    clerkUser?.primaryEmailAddress?.emailAddress ||
    toolbarData.user?.email ||
    "";
  const canViewAdmin = isAdminEmail(
    clerkUser?.primaryEmailAddress?.emailAddress || toolbarData.user?.email,
  );

  if (activeTab === "admin" && !canViewAdmin) {
    return null;
  }

  return (
    <ReviewToolbarActions
      className="persistent-toolbar-actions"
      activeTab={activeTab}
      dueCount={toolbarData.dueCount}
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

        clerk.openUserProfile({
          customPages: accountWidgetsCustomPages,
        });
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
