export type ScheduleWeekday =
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type ScheduleSpec =
  | { readonly cadence: "hourly"; readonly minuteOfHour: number }
  | {
      readonly cadence: "daily";
      readonly timeOfDay: string;
      readonly timezone: string;
    }
  | {
      readonly cadence: "weekly";
      readonly weekday: ScheduleWeekday;
      readonly timeOfDay: string;
      readonly timezone: string;
    };
