export function reviewLocalDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Search for the next calendar-day change rather than adding 24 hours: DST
// gives some learner days 23 or 25 hours.
export function nextReviewDayBoundary(now: Date, timezone: string): number {
  const today = reviewLocalDay(now, timezone);
  let low = now.getTime();
  let high = low + 36 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (reviewLocalDay(new Date(middle), timezone) === today) low = middle;
    else high = middle;
  }
  return high;
}
