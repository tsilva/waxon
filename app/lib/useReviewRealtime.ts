"use client";

import { useEffect, useRef } from "react";
import { watchReviewRealtime } from "./reviewRealtimeClient";
import { nextReviewDayBoundary, reviewLocalDay } from "./reviewLocalDay";

export function useReviewRealtime(options: {
  enabled: boolean;
  timezone: string | null;
  onChange(): Promise<unknown>;
  onError(message: string): void;
}) {
  const callbacks = useRef(options);
  useEffect(() => { callbacks.current = options; });
  useEffect(() => {
    if (!options.enabled) return;
    const timezone = options.timezone ?? "UTC";
    let session: ReturnType<typeof watchReviewRealtime> | undefined;
    let day = "";
    let dayTimer = 0;
    const start = () => {
      if (document.visibilityState === "hidden" || navigator.onLine === false) return;
      const now = new Date();
      const currentDay = reviewLocalDay(now, timezone);
      if (day && day !== currentDay) {
        void callbacks.current.onChange().catch(() => callbacks.current.onError("Could not refresh Review."));
      }
      day = currentDay;
      if (!session || session.failed()) {
        session?.stop();
        session = watchReviewRealtime({
          onChange: () => callbacks.current.onChange(),
          onError: (message) => callbacks.current.onError(message),
        });
      }
      window.clearTimeout(dayTimer);
      dayTimer = window.setTimeout(start, nextReviewDayBoundary(now, timezone) - now.getTime() + 50);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        session?.stop();
        session = undefined;
        window.clearTimeout(dayTimer);
      } else start();
    };
    start();
    window.addEventListener("focus", start);
    window.addEventListener("online", start);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      session?.stop();
      window.clearTimeout(dayTimer);
      window.removeEventListener("focus", start);
      window.removeEventListener("online", start);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [options.enabled, options.timezone]);
}
