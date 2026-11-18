/**
 * Pure schedule-window arithmetic for agent schedule bindings (plan 30 R2/R3).
 *
 * A window is the most recent due instant at or before a given time. The cron
 * dispatcher fires a binding when its stored last-dispatched window differs
 * from the current window key, so a binding fires at the first tick at or
 * after its due instant, exactly once per window, and missed windows are never
 * backfilled. Local-calendar arithmetic goes through Intl so daylight-saving
 * transitions cannot shift the computed local date.
 */

import { assertNever, exhaustiveList } from "@seams/std";
import type { ScheduleSpec, ScheduleWeekday } from "@seams/control-api";

const WEEKDAYS = exhaustiveList<ScheduleWeekday>()([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);
const TIME_OF_DAY_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const HOUR_MS = 3_600_000;

export function isScheduleWeekday(value: unknown): value is ScheduleWeekday {
  return (
    typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value)
  );
}

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && TIME_OF_DAY_PATTERN.test(value);
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stable identity of a schedule's configured time, independent of any
 * concrete occurrence. Persisted as schedule_binding.schedule_time_key and
 * part of the binding uniqueness, so one installation may hold two
 * differently-timed schedules of the same cadence.
 */
export function scheduleTimeKey(spec: ScheduleSpec): string {
  switch (spec.cadence) {
    case "hourly":
      return `hourly@:${padTwo(spec.minuteOfHour)}`;
    case "daily":
      return `daily@${spec.timeOfDay}@${spec.timezone}`;
    case "weekly":
      return `weekly@${spec.weekday}@${spec.timeOfDay}@${spec.timezone}`;
    default:
      return assertNever(spec, "schedule_window_unhandled_");
  }
}

/**
 * The key of the current window: the most recent due instant at or before
 * nowMs. Keys embed the occurrence date (or UTC hour) plus the configured
 * time, so consecutive windows always produce distinct keys.
 */
export function computeScheduleWindowKey(
  spec: ScheduleSpec,
  nowMs: number,
): string {
  switch (spec.cadence) {
    case "hourly":
      return hourlyWindowKey(spec.minuteOfHour, nowMs);
    case "daily":
      return dailyWindowKey(spec.timeOfDay, spec.timezone, nowMs);
    case "weekly":
      return weeklyWindowKey(
        spec.weekday,
        spec.timeOfDay,
        spec.timezone,
        nowMs,
      );
    default:
      return assertNever(spec, "schedule_window_unhandled_");
  }
}

function hourlyWindowKey(minuteOfHour: number, nowMs: number): string {
  const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const candidate = hourStart + minuteOfHour * 60_000;
  const windowStart = candidate <= nowMs ? candidate : candidate - HOUR_MS;
  const at = new Date(windowStart);
  const date = `${at.getUTCFullYear()}-${padTwo(at.getUTCMonth() + 1)}-${padTwo(at.getUTCDate())}`;
  return `${date}T${padTwo(at.getUTCHours())}:${padTwo(at.getUTCMinutes())}Z/hourly`;
}

function dailyWindowKey(
  timeOfDay: string,
  timezone: string,
  nowMs: number,
): string {
  const local = localParts(nowMs, timezone);
  const date =
    local.time >= timeOfDay
      ? { year: local.year, month: local.month, day: local.day }
      : shiftDate(local.year, local.month, local.day, -1);
  return `${isoDate(date)}T${timeOfDay}@${timezone}/daily`;
}

function weeklyWindowKey(
  weekday: ScheduleWeekday,
  timeOfDay: string,
  timezone: string,
  nowMs: number,
): string {
  const local = localParts(nowMs, timezone);
  const todayIndex = WEEKDAYS.indexOf(local.weekday);
  const targetIndex = WEEKDAYS.indexOf(weekday);
  let daysBack = (todayIndex - targetIndex + 7) % 7;
  if (daysBack === 0 && local.time < timeOfDay) daysBack = 7;
  const date = shiftDate(local.year, local.month, local.day, -daysBack);
  return `${isoDate(date)}T${timeOfDay}@${timezone}/weekly`;
}

type LocalParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly time: string;
  readonly weekday: ScheduleWeekday;
};

function localParts(nowMs: number, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(new Date(nowMs))) {
    parts.set(part.type, part.value);
  }
  const weekday = parts.get("weekday")?.slice(0, 3).toLowerCase();
  if (!isScheduleWeekday(weekday)) throw new Error("schedule_window_weekday");
  const hour = parts.get("hour") === "24" ? "00" : parts.get("hour");
  return {
    year: requiredInteger(parts.get("year")),
    month: requiredInteger(parts.get("month")),
    day: requiredInteger(parts.get("day")),
    time: `${hour}:${parts.get("minute")}`,
    weekday,
  };
}

type CalendarDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

function shiftDate(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): CalendarDate {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays, 12));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function isoDate(date: CalendarDate): string {
  return `${date.year}-${padTwo(date.month)}-${padTwo(date.day)}`;
}

function requiredInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("schedule_window_part");
  return parsed;
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}
