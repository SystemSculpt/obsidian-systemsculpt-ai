/**
 * Grouping and compact times for the in-view chat history: Favorites, Today,
 * Yesterday, Previous 7 days, Previous 30 days, then one group per month.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function daysBefore(timestampMs: number, nowMs: number): number {
  return Math.round((startOfDay(nowMs) - startOfDay(timestampMs)) / DAY_MS);
}

export function chatHistoryGroup(
  timestampMs: number,
  favorite: boolean,
  nowMs: number,
  locale?: string,
): string {
  if (favorite) return "Favorites";
  const days = daysBefore(timestampMs, nowMs);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  const date = new Date(timestampMs);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: "long" } : { month: "long", year: "numeric" });
}

/** "now", "2m" and "1h" today; "9:14" yesterday; "Mon" this week; then "Oct 12". */
export function chatHistoryTime(timestampMs: number, nowMs: number, locale?: string): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  const date = new Date(timestampMs);
  const days = daysBefore(timestampMs, nowMs);
  if (days <= 0) {
    const minutes = Math.max(0, Math.floor((nowMs - timestampMs) / 60_000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }
  if (days === 1) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "short" });
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(
    locale,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** The full date and time, for a row's tooltip. */
export function chatHistoryFullTime(timestampMs: number, locale?: string): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  return new Date(timestampMs).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
