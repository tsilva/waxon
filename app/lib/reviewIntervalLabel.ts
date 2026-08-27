const DAY_IN_MILLISECONDS = 86_400_000;

type ReviewIntervalLabelOptions = {
  locale?: string | string[];
  now?: Date;
};

function calendarDayInUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? timestamp
    : null;
}

export function reviewIntervalLabel(
  value: string | null,
  options: ReviewIntervalLabelOptions = {},
): string | null {
  if (!value) return null;

  const dueDay = calendarDayInUtc(value);
  const now = options.now ?? new Date();
  if (dueDay === null || !Number.isFinite(now.getTime())) return null;

  const today = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const daysUntilReview = Math.round(
    (dueDay - today) / DAY_IN_MILLISECONDS,
  );

  if (daysUntilReview <= 0) return "Review now";

  let amount = daysUntilReview;
  let unit: Intl.RelativeTimeFormatUnit = "day";
  if (daysUntilReview >= 730) {
    amount = Math.round(daysUntilReview / 365.25);
    unit = "year";
  } else if (daysUntilReview >= 60) {
    amount = Math.round(daysUntilReview / 30.4375);
    unit = "month";
  } else if (daysUntilReview >= 14) {
    amount = Math.round(daysUntilReview / 7);
    unit = "week";
  }

  const interval = new Intl.RelativeTimeFormat(options.locale, {
    numeric: "always",
    style: "long",
  }).format(amount, unit);
  return `Review ${interval}`;
}
