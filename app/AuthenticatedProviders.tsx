"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppViewCacheProvider, useAppViewCache } from "./AppViewCache";
import { AppErrorProvider } from "./AppErrorModal";
import { AuthShell } from "./AuthShell";
import { LocalAccountSettings } from "./LocalAccountSettings";
import { PersistentReviewToolbarActions } from "./PersistentReviewToolbarActions";
import { ToolbarStateProvider, useToolbarState } from "./ToolbarState";

function LearningViewPreloader() {
  const pathname = usePathname();
  const viewCache = useAppViewCache();
  const { setDueCount } = useToolbarState();
  useEffect(() => {
    if (pathname.startsWith("/review") || pathname.startsWith("/library")) {
      void viewCache.preloadReview().then(() => {
        const review = viewCache.readReview(); if (review) setDueCount(review.summary.queueRemaining);
      });
    } else {
      const controller = new AbortController();
      void fetch("/api/v2/review/summary", { signal: controller.signal, cache: "no-store" })
        .then(async (response) => { if (response.ok) { const summary = await response.json();
          if (!controller.signal.aborted) setDueCount(summary.queueRemaining); } }).catch(() => {});
      return () => controller.abort();
    }
    if (pathname.startsWith("/library")) void viewCache.preloadLibrary();
  }, [pathname, setDueCount, viewCache]);
  return null;
}

export function AuthenticatedProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isLocalAccountSettingsOpen, setIsLocalAccountSettingsOpen] =
    useState(false);
  const closeLocalAccountSettings = useCallback(
    () => setIsLocalAccountSettingsOpen(false),
    [],
  );

  return (
    <AuthShell>
      <AppErrorProvider>
        <ToolbarStateProvider>
          <AppViewCacheProvider>
            <LearningViewPreloader />
            <PersistentReviewToolbarActions
              onManageLocalAccount={() => setIsLocalAccountSettingsOpen(true)}
            />
            {children}
            <LocalAccountSettings
              isOpen={isLocalAccountSettingsOpen}
              onClose={closeLocalAccountSettings}
            />
          </AppViewCacheProvider>
        </ToolbarStateProvider>
      </AppErrorProvider>
    </AuthShell>
  );
}
