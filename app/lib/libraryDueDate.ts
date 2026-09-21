export function formatLibraryDueDate(dueAt: string, now: Date): string {
  const due = new Date(dueAt);
  const remaining = due.getTime() - now.getTime();
  const day = 24 * 60 * 60 * 1_000;
  if (remaining <= 0) return "Due now";
  if (remaining > 7 * day) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(due);
  }
  if (remaining >= day) {
    const days = Math.floor(remaining / day);
    return `${days} ${days === 1 ? "day" : "days"} from now`;
  }

  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return `${hours > 0 ? `${hours}h` : ""}${minutes % 60}m from now`;
}
