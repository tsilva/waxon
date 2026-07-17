"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { isAdminEmail } from "@/app/lib/adminAccess";
import type { UserProfile } from "@/app/lib/userProfile";

type ToolbarStateValue = {
  canViewAdmin: boolean;
  currentUser: UserProfile | null;
  dueCount: number | null;
  setCurrentUser: Dispatch<SetStateAction<UserProfile | null>>;
  setDueCount: Dispatch<SetStateAction<number | null>>;
};

type ReviewSummaryResponse = {
  queueRemaining: number;
};

const ToolbarStateContext = createContext<ToolbarStateValue | null>(null);

export function ToolbarStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [dueCount, setDueCount] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadToolbarState() {
      try {
        const [userResult, summaryResult] = await Promise.allSettled([
          fetch("/api/user", {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch("/api/review-summary", {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);

        if (controller.signal.aborted) {
          return;
        }

        if (userResult.status === "fulfilled" && userResult.value.ok) {
          setCurrentUser((await userResult.value.json()) as UserProfile);
        }

        if (summaryResult.status === "fulfilled" && summaryResult.value.ok) {
          const summary = (await summaryResult.value.json()) as ReviewSummaryResponse;
          setDueCount(summary.queueRemaining);
        }
      } catch {
        // Toolbar data is supplemental; page-level content remains usable.
      }
    }

    void loadToolbarState();

    return () => controller.abort();
  }, []);

  const value = useMemo<ToolbarStateValue>(
    () => ({
      canViewAdmin: isAdminEmail(currentUser?.email),
      currentUser,
      dueCount,
      setCurrentUser,
      setDueCount,
    }),
    [currentUser, dueCount],
  );

  return (
    <ToolbarStateContext.Provider value={value}>
      {children}
    </ToolbarStateContext.Provider>
  );
}

export function useToolbarState(): ToolbarStateValue {
  const context = useContext(ToolbarStateContext);

  if (!context) {
    throw new Error("useToolbarState must be used inside ToolbarStateProvider.");
  }

  return context;
}
