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

export interface ScheduleShape {
  frequency: "daily" | "weekdays" | "weekly" | "monthly";
  time: string;
  weekday?: number;
  monthDay?: number;
}

const FREQUENCIES = ["daily", "weekdays", "weekly", "monthly"] as const;

/** Checks a schedule from the API, filling in sensible defaults; throws a message on bad input. */
export function normalizeSchedule(value: unknown): ScheduleShape {
  const v = (value ?? {}) as Record<string, unknown>;
  const frequency = String(v.frequency ?? "") as ScheduleShape["frequency"];
  if (!FREQUENCIES.includes(frequency))
    throw new Error("Schedule frequency must be daily, weekdays, weekly or monthly");
  const time = String(v.time ?? "09:00");
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error("Schedule time must look like 08:30");
  const schedule: ScheduleShape = { frequency, time: `${match[1]?.padStart(2, "0")}:${match[2]}` };
  if (frequency === "weekly") {
    const weekday = Number(v.weekday ?? 1);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
      throw new Error("Schedule weekday must be 0 (Sunday) to 6 (Saturday)");
    schedule.weekday = weekday;
  }
  if (frequency === "monthly") {
    const monthDay = Number(v.monthDay ?? 1);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)
      throw new Error("Schedule day of the month must be 1 to 31");
    schedule.monthDay = monthDay;
  }
  return schedule;
}

function daysInMonth(date: string) {
  const [y = 1970, m = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function matches(schedule: ScheduleShape, date: string) {
  const day = weekday(date);
  switch (schedule.frequency) {
    case "daily":
      return true;
    case "weekdays":
      return day >= 1 && day <= 5;
    case "weekly":
      return day === (schedule.weekday ?? 1);
    case "monthly": {
      const dom = Number(date.slice(8, 10));
      return dom === Math.min(schedule.monthDay ?? 1, daysInMonth(date));
    }
  }
}

/** The first time the schedule fires strictly after `after`. */
export function nextOccurrence(schedule: ScheduleShape, timeZone: string, after: number): number {
  const [hour = 9, minute = 0] = schedule.time.split(":").map(Number);
  const start = localDate(after, timeZone);
  for (let i = 0; i < 400; i++) {
    const date = addDays(start, i);
    if (!matches(schedule, date)) continue;
    const at = zonedTime(date, timeZone, hour, minute);
    if (at > after) return at;
  }
  throw new Error("The schedule never fires");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Weekdays at 08:00", "Mondays at 09:30", "Monthly on the 1st at 07:00". */
export function describeSchedule(schedule: ScheduleShape): string {
  const at = `at ${schedule.time}`;
  switch (schedule.frequency) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Weekdays ${at}`;
    case "weekly":
      return `${WEEKDAYS[schedule.weekday ?? 1]}s ${at}`;
    case "monthly": {
      const d = schedule.monthDay ?? 1;
      const suffix =
        d % 10 === 1 && d !== 11
          ? "st"
          : d % 10 === 2 && d !== 12
            ? "nd"
            : d % 10 === 3 && d !== 13
              ? "rd"
              : "th";
      return `Monthly on the ${d}${suffix} ${at}`;
    }
  }
}
