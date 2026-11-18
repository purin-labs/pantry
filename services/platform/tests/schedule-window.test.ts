import { describe, expect, it } from "vitest";

import {
  computeScheduleWindowKey,
  isTimeOfDay,
  isValidTimeZone,
  scheduleTimeKey,
} from "../src/schedules/window";

describe("Schedule windows", () => {
  it("computes hourly windows in UTC", () => {
    const spec = { cadence: "hourly", minuteOfHour: 15 } as const;
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 24, 5, 20))).toBe(
      "2026-08-24T05:15Z/hourly",
    );
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 24, 5, 10))).toBe(
      "2026-08-24T04:15Z/hourly",
    );
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 24, 5, 15))).toBe(
      "2026-08-24T05:15Z/hourly",
    );
    expect(
      computeScheduleWindowKey(
        { cadence: "hourly", minuteOfHour: 0 },
        Date.UTC(2026, 7, 24, 0, 0),
      ),
    ).toBe("2026-08-24T00:00Z/hourly");
  });

  it("computes daily windows in the configured timezone", () => {
    const tokyo = {
      cadence: "daily",
      timeOfDay: "07:00",
      timezone: "Asia/Tokyo",
    } as const;
    // 21:59Z on Aug 24 is 06:59 JST on Aug 25 — the current window is still Aug 24's.
    expect(computeScheduleWindowKey(tokyo, Date.UTC(2026, 7, 24, 21, 59))).toBe(
      "2026-08-24T07:00@Asia/Tokyo/daily",
    );
    // 22:00Z is exactly 07:00 JST on Aug 25 — the window rolls over.
    expect(computeScheduleWindowKey(tokyo, Date.UTC(2026, 7, 24, 22, 0))).toBe(
      "2026-08-25T07:00@Asia/Tokyo/daily",
    );
  });

  it("crosses month boundaries without backfill drift", () => {
    const utc = {
      cadence: "daily",
      timeOfDay: "23:30",
      timezone: "UTC",
    } as const;
    expect(computeScheduleWindowKey(utc, Date.UTC(2026, 8, 1, 0, 10))).toBe(
      "2026-08-31T23:30@UTC/daily",
    );
  });

  it("stays on the correct local date across the spring DST transition", () => {
    const newYork = {
      cadence: "daily",
      timeOfDay: "02:30",
      timezone: "America/New_York",
    } as const;
    // 2026-03-08 02:30 EST does not exist; by 03:30 EDT (07:30Z) the window is due.
    expect(computeScheduleWindowKey(newYork, Date.UTC(2026, 2, 8, 7, 30))).toBe(
      "2026-03-08T02:30@America/New_York/daily",
    );
    // 01:00 EST (06:00Z) is before the configured time — previous day's window.
    expect(computeScheduleWindowKey(newYork, Date.UTC(2026, 2, 8, 6, 0))).toBe(
      "2026-03-07T02:30@America/New_York/daily",
    );
  });

  it("computes weekly windows against the local weekday", () => {
    const spec = {
      cadence: "weekly",
      weekday: "mon",
      timeOfDay: "07:00",
      timezone: "Asia/Tokyo",
    } as const;
    // Monday 2026-08-24 07:00 JST is 2026-08-23 22:00Z.
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 23, 22, 0))).toBe(
      "2026-08-24T07:00@Asia/Tokyo/weekly",
    );
    // One minute earlier the most recent occurrence is the previous Monday.
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 23, 21, 59))).toBe(
      "2026-08-17T07:00@Asia/Tokyo/weekly",
    );
    // Midweek stays on the past Monday.
    expect(computeScheduleWindowKey(spec, Date.UTC(2026, 7, 26, 12, 0))).toBe(
      "2026-08-24T07:00@Asia/Tokyo/weekly",
    );
  });

  it("derives stable time keys per configured time", () => {
    expect(scheduleTimeKey({ cadence: "hourly", minuteOfHour: 5 })).toBe(
      "hourly@:05",
    );
    expect(
      scheduleTimeKey({
        cadence: "daily",
        timeOfDay: "07:00",
        timezone: "Asia/Tokyo",
      }),
    ).toBe("daily@07:00@Asia/Tokyo");
    expect(
      scheduleTimeKey({
        cadence: "weekly",
        weekday: "fri",
        timeOfDay: "18:30",
        timezone: "UTC",
      }),
    ).toBe("weekly@fri@18:30@UTC");
  });

  it("validates times and timezones exactly", () => {
    expect(isTimeOfDay("07:00")).toBe(true);
    expect(isTimeOfDay("23:59")).toBe(true);
    expect(isTimeOfDay("24:00")).toBe(false);
    expect(isTimeOfDay("7:00")).toBe(false);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
