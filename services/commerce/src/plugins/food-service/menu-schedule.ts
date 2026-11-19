// The shop's own clock (Plan 40B phase 3): the repeating time slots of a menu
// and the end of a "sold out today" mark. Commerce stores instants in UTC, so
// each rule names the IANA time zone that it reads the clock in.
import type { MenuValidity } from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";

type MenuSchedule = Variant<MenuValidity, "schedule">;

const MAX_SLOTS = 28;
const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const MINUTE = 60_000;
const DAY_MINUTES = 1_440;

type LocalClock = Readonly<{ weekday: string; minutes: number }>;

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A slot ends on the day it starts: a slot past midnight is two slots. */
export function menuScheduleIsValid(schedule: MenuSchedule): boolean {
  return (
    isKnownTimeZone(schedule.timeZone) &&
    schedule.slots.length > 0 &&
    schedule.slots.length <= MAX_SLOTS &&
    schedule.slots.every(
      (slot) =>
        slot.days.length > 0 &&
        new Set(slot.days).size === slot.days.length &&
        START_TIME.test(slot.startsAt) &&
        END_TIME.test(slot.endsAt) &&
        slot.startsAt < slot.endsAt,
    )
  );
}

export function menuScheduleIsOpen(
  schedule: MenuSchedule,
  instant: number,
): boolean {
  const clock = localClock(instant, schedule.timeZone);
  return schedule.slots.some(
    (slot) =>
      slot.days.some((day) => day === clock.weekday) &&
      clock.minutes >= clockMinutes(slot.startsAt) &&
      clock.minutes < clockMinutes(slot.endsAt),
  );
}

/** The next midnight on the shop's clock, also across a clock change. */
export function nextLocalMidnight(instant: number, timeZone: string): number {
  const wholeMinute = instant - (instant % MINUTE);
  const left = DAY_MINUTES - localClock(instant, timeZone).minutes;
  const estimate = wholeMinute + left * MINUTE;
  // A clock change that day moves the estimate away from midnight.
  const { minutes } = localClock(estimate, timeZone);
  const drift = minutes < DAY_MINUTES / 2 ? minutes : minutes - DAY_MINUTES;
  return estimate - drift * MINUTE;
}

function clockMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function localClock(instant: number, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    weekday: part("weekday").toLowerCase(),
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}
