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
        const response = await fetch("/api/user", { cache: "no-store", signal: controller.signal });
        if (response.ok && !controller.signal.aborted) setCurrentUser((await response.json()) as UserProfile);

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
