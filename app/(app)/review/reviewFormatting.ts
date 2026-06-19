import type { ReviewQueueItem } from "@/app/lib/reviewTypes";

export function formatDurationBadge(msUntilDue: number): string {
  if (msUntilDue <= 0) {
    return "NOW";
  }

  const totalSeconds = Math.ceil(msUntilDue / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

export function formatDueBadge(item: ReviewQueueItem): string {
  return formatDurationBadge(item.msUntilDue);
}
