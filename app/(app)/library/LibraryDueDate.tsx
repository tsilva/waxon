"use client";

import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { formatLibraryDueDate } from "@/app/lib/libraryDueDate";

export function LibraryDueDate({ dueAt }: { dueAt: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const timer = window.setInterval(update, 1_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <span className="lean-question-date">
      <CalendarClock />
      <time dateTime={dueAt} title={now ? new Date(dueAt).toLocaleString() : undefined}>
        {now ? formatLibraryDueDate(dueAt, now) : "…"}
      </time>
    </span>
  );
}
