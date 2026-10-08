// Calendar arithmetic in the company's time zone, with Intl only, so it runs on Workers too.
// Dates are `YYYY-MM-DD` strings; instants are epoch milliseconds.

export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, timeZone: string) {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** How far the zone's wall clock is ahead of UTC at that instant, in ms. */
function offset(ms: number, timeZone: string) {
  const p = parts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The calendar date at that instant in the zone. */
export function localDate(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** The hour (0–23) at that instant in the zone. */
export function localHour(ms: number, timeZone: string): number {
  return parts(ms, timeZone).hour;
}

/** The instant a wall-clock time happens in the zone (midnight by default). */
export function zonedTime(date: string, timeZone: string, hour = 0, minute = 0): number {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  // Two passes settle the offset, including on days the clocks change.
  let at = wall - offset(wall, timeZone);
  at = wall - offset(at, timeZone);
  return at;
}

export function addDays(date: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 Sunday … 6 Saturday. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Whole days from one date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
