function monthDays(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
type UtcTimestamp = Readonly<{
  year: number;
  month: number;
  day: number;
  minutes: number;
  second: number;
  nanosecond: number;
}>;

/** RFC 3339 as the Rust `time` crate parses it, moved to UTC. */
function utcTimestamp(value: string): UtcTimestamp | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[\x00-\x7f](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[zZ]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return null;
  let year = Number(match[1]);
  let month = Number(match[2]);
  let day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const offset = (match[8] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  let minutes = hour * 60 + minute - offset;
  if (minutes < 0) {
    minutes += 1440;
    day--;
    if (day === 0) {
      month--;
      if (month === 0) {
        month = 12;
        year--;
      }
      day = monthDays(year, month);
    }
  }
  if (minutes >= 1440) {
    minutes -= 1440;
    day++;
    if (day > monthDays(year, month)) {
      day = 1;
      month++;
      if (month === 13) {
        month = 1;
        year++;
      }
    }
  }
  if (year < 0 || year > 9999) return null;
  if (second === 60 && (minutes !== 1439 || day !== monthDays(year, month)))
    return null;
  // A leap second is held as the last nanosecond of second 59.
  return {
    year,
    month,
    day,
    minutes,
    second: Math.min(second, 59),
    nanosecond:
      second === 60
        ? 999999999
        : Number((match[7] ?? "").slice(0, 9).padEnd(9, "0")),
  };
}

export function timestampNanoseconds(value: string): bigint | null {
  const time = utcTimestamp(value);
  if (time === null) return null;
  // Count days from year zero. All arithmetic stays exact before conversion to bigint.
  let days =
    365 * time.year +
    Math.floor((time.year + 3) / 4) -
    Math.floor((time.year + 99) / 100) +
    Math.floor((time.year + 399) / 400);
  for (let previousMonth = 1; previousMonth < time.month; previousMonth++)
    days += monthDays(time.year, previousMonth);
  days += time.day - 1;
  return (
    BigInt(days * 86400 + time.minutes * 60 + time.second) * 1000000000n +
    BigInt(time.nanosecond)
  );
}

/**
 * Rust `CommerceTimestamp::parse`: the UTC text that the `time` crate writes
 * for RFC 3339, with the fraction's trailing zeros removed.
 */
export function normalizeCommerceTimestamp(value: string): string | null {
  const time = utcTimestamp(value);
  if (time === null) return null;
  const fraction =
    time.nanosecond === 0
      ? ""
      : "." + String(time.nanosecond).padStart(9, "0").replace(/0+$/, "");
  return (
    `${String(time.year).padStart(4, "0")}-${two(time.month)}-${two(time.day)}` +
    `T${two(Math.floor(time.minutes / 60))}:${two(time.minutes % 60)}:${two(time.second)}` +
    `${fraction}Z`
  );
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function validTimestamp(value: string): boolean {
  return timestampNanoseconds(value) !== null;
}
