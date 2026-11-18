import type { ScheduleSpec, ScheduleWeekday } from "@seams/control-api";

// When a schedule's windows open, as the dispatcher keys them: an hourly
// schedule at its minute of each UTC hour, a daily or weekly one at its time
// of day on the dates of its own time zone.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS: readonly ScheduleWeekday[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** The instants in [from, to) at which the schedule's windows open. */
export function scheduleWindows(
  spec: ScheduleSpec,
  from: number,
  to: number,
): number[] {
  const windows: number[] = [];
  if (spec.cadence === "hourly") {
    const first = Math.floor(from / HOUR) * HOUR + spec.minuteOfHour * MINUTE;
    for (let at = first; at < to; at += HOUR) if (at >= from) windows.push(at);
    return windows;
  }
  const [hour, minute] = spec.timeOfDay.split(":").map(Number);
  if (hour === undefined || minute === undefined) return windows;
  // Each date of the zone that the range touches, with a day on each side
  // for zones far from UTC.
  const start = zonedParts(from - DAY, spec.timezone);
  if (start === null) return windows;
  for (let offset = 0; offset < Math.ceil((to - from) / DAY) + 3; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day));
    date.setUTCDate(date.getUTCDate() + offset);
    if (
      spec.cadence === "weekly" &&
      WEEKDAYS[date.getUTCDay()] !== spec.weekday
    )
      continue;
    const at = zonedInstant(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
      spec.timezone,
    );
    if (at !== null && at >= from && at < to) windows.push(at);
  }
  return windows;
}

type Parts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}>;

function zonedParts(at: number, timeZone: string): Parts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const value = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value);
    return {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
    };
  } catch {
    return null;
  }
}

/** The instant at which the zone's clock shows this date and time. */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let at = wall;
  // Two steps settle the zone's offset, also next to a daylight-saving change.
  for (let step = 0; step < 2; step += 1) {
    const parts = zonedParts(at, timeZone);
    if (parts === null) return null;
    const shown = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    at += wall - shown;
  }
  return at;
}
