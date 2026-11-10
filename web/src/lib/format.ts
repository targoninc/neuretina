export function formatDateTime(ts: number | undefined, fallback = "–"): string {
  return ts ? new Date(ts).toLocaleString() : fallback;
}

/** Local wall-clock time for activity feeds. */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Compact elapsed time for activity rows: "820ms", "3.4s", "2m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms);
  if (total < 1000) return `${Math.round(total)}ms`;

  const seconds = total / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** USD amount with exactly two decimals. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Relative time like "5 minutes ago" or "yesterday". */
export function formatRelativeTime(
  ts: number | undefined,
  now = Date.now(),
  locale?: string,
): string {
  if (!ts) return "–";

  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["week", 7 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  for (const [unit, ms] of units) {
    if (abs >= ms) return formatter.format(Math.round(diff / ms), unit);
  }
  return formatter.format(0, "second");
}
