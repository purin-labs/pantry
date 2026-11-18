import { isNonNegativeInteger } from "@seams/std";
import { err, ok, type Result } from "./result.ts";

declare const logicalTimeBrand: unique symbol;
declare const tickDurationBrand: unique symbol;
declare const stepCountBrand: unique symbol;

/** The factory tick. Every authored time and every evolving model step lies on it. */
export const TICK_MICROSECONDS = 2_000;
/** Evolving cells compute at most this many ticks beyond the accepted boundary. */
export const LOOKAHEAD_TICKS = 32;
/** One year. Keeps sums of admitted times far inside the safe-integer range. */
export const MAX_LOGICAL_MICROSECONDS = 366 * 24 * 3_600 * 1_000_000;

/** Factory logical time in integer microseconds, on the tick grid. */
export type LogicalTime = number & {
  readonly [logicalTimeBrand]: "LogicalTime";
};
/** A non-negative span in integer microseconds, on the tick grid. */
export type TickDuration = number & {
  readonly [tickDurationBrand]: "TickDuration";
};
/** Completed native integration steps since an attempt's original dispatch. */
export type StepCount = number & { readonly [stepCountBrand]: "StepCount" };

export type TimeError =
  | Readonly<{ code: "not_a_safe_integer"; microseconds: number }>
  | Readonly<{ code: "negative"; microseconds: number }>
  | Readonly<{ code: "out_of_range"; microseconds: number }>
  | Readonly<{ code: "sub_microsecond"; seconds: number }>
  | Readonly<{
      code: "off_grid";
      microseconds: number;
      tickMicroseconds: typeof TICK_MICROSECONDS;
    }>
  | Readonly<{
      code: "timestep_mismatch";
      microseconds: number;
      tickMicroseconds: typeof TICK_MICROSECONDS;
    }>;

export const ZERO_TIME = 0 as LogicalTime;
export const ZERO_DURATION = 0 as TickDuration;
export const ZERO_STEPS = 0 as StepCount;

// Off-grid values are rejected with the offending value. Nothing here rounds.
function onGrid(microseconds: number): Result<number, TimeError> {
  if (!Number.isSafeInteger(microseconds))
    return err({ code: "not_a_safe_integer", microseconds });
  if (microseconds < 0) return err({ code: "negative", microseconds });
  if (microseconds > MAX_LOGICAL_MICROSECONDS)
    return err({ code: "out_of_range", microseconds });
  if (microseconds % TICK_MICROSECONDS !== 0)
    return err({
      code: "off_grid",
      microseconds,
      tickMicroseconds: TICK_MICROSECONDS,
    });
  return ok(microseconds);
}

export function logicalTime(
  microseconds: number,
): Result<LogicalTime, TimeError> {
  const checked = onGrid(microseconds);
  return checked.ok ? ok(checked.value as LogicalTime) : checked;
}

export function tickDuration(
  microseconds: number,
): Result<TickDuration, TimeError> {
  const checked = onGrid(microseconds);
  return checked.ok ? ok(checked.value as TickDuration) : checked;
}

/**
 * Authored decimal seconds as exact microseconds. The tolerance covers only the
 * binary representation of a decimal value; a real sub-microsecond part fails.
 */
export function microsecondsFromSeconds(
  seconds: number,
): Result<number, TimeError> {
  const scaled = seconds * 1_000_000;
  const rounded = Math.round(scaled);
  const tolerance = Math.max(1e-6, Math.abs(scaled) * 4 * Number.EPSILON);
  if (!Number.isFinite(seconds) || Math.abs(scaled - rounded) > tolerance)
    return err({ code: "sub_microsecond", seconds });
  return ok(rounded);
}

export function timeFromSeconds(
  seconds: number,
): Result<LogicalTime, TimeError> {
  const microseconds = microsecondsFromSeconds(seconds);
  return microseconds.ok ? logicalTime(microseconds.value) : microseconds;
}

export function durationFromSeconds(
  seconds: number,
): Result<TickDuration, TimeError> {
  const microseconds = microsecondsFromSeconds(seconds);
  return microseconds.ok ? tickDuration(microseconds.value) : microseconds;
}

/** A model may join the factory only when its timestep is exactly one tick. */
export function modelTimestep(
  seconds: number,
): Result<typeof TICK_MICROSECONDS, TimeError> {
  const microseconds = microsecondsFromSeconds(seconds);
  if (!microseconds.ok) return microseconds;
  if (microseconds.value !== TICK_MICROSECONDS)
    return err({
      code: "timestep_mismatch",
      microseconds: microseconds.value,
      tickMicroseconds: TICK_MICROSECONDS,
    });
  return ok(TICK_MICROSECONDS);
}

export type StepError = Readonly<{ code: "invalid_step_count"; steps: number }>;

export function stepCount(steps: number): Result<StepCount, StepError> {
  return isNonNegativeInteger(steps) &&
    steps <= MAX_LOGICAL_MICROSECONDS / TICK_MICROSECONDS
    ? ok(steps as StepCount)
    : err({ code: "invalid_step_count", steps });
}

export function advance(time: LogicalTime, by: TickDuration): LogicalTime {
  return (time + by) as LogicalTime;
}

/** A duration repeated a whole number of times, such as a periodic interval. */
export function repeat(duration: TickDuration, times: number): TickDuration {
  if (!isNonNegativeInteger(times))
    throw new RangeError("A repetition count is a non-negative integer");
  return (duration * times) as TickDuration;
}

export function elapsed(from: LogicalTime, to: LogicalTime): TickDuration {
  if (to < from) throw new RangeError("Elapsed time cannot be negative");
  return (to - from) as TickDuration;
}

export function stepsDuration(steps: StepCount): TickDuration {
  return (steps * TICK_MICROSECONDS) as TickDuration;
}

export function addSteps(left: StepCount, right: StepCount): StepCount {
  return (left + right) as StepCount;
}

/** The whole steps between two times on the grid; `to` is never earlier. */
export function stepsBetween(from: LogicalTime, to: LogicalTime): StepCount {
  if (to < from) throw new RangeError("Steps cannot run backwards");
  return ((to - from) / TICK_MICROSECONDS) as StepCount;
}

/**
 * Native event time is the original dispatch plus cumulative native steps.
 * Pause, resume and receipt time never become a new logical start.
 */
export function nativeEventTime(
  dispatchedAt: LogicalTime,
  steps: StepCount,
): LogicalTime {
  return advance(dispatchedAt, stepsDuration(steps));
}

/** The furthest factory time an evolving cell may compute to. */
export function lookaheadHorizon(
  acceptedBoundary: LogicalTime,
  nextKnownEvent: LogicalTime | null,
): LogicalTime {
  const limit = (acceptedBoundary +
    LOOKAHEAD_TICKS * TICK_MICROSECONDS) as LogicalTime;
  return nextKnownEvent !== null && nextKnownEvent < limit
    ? nextKnownEvent
    : limit;
}

/**
 * The furthest factory time a cell may compute to when it shares the run
 * with other cells: the next point of a fixed grid of `LOOKAHEAD_TICKS`
 * ticks, or the next known event if it comes first. Every cell ends its
 * calls on the same grid, so the cells meet at one time after each event,
 * and a pause can settle there.
 */
export function sharedLookaheadHorizon(
  acceptedBoundary: LogicalTime,
  nextKnownEvent: LogicalTime | null,
): LogicalTime {
  const span = LOOKAHEAD_TICKS * TICK_MICROSECONDS;
  const limit = ((Math.floor(acceptedBoundary / span) + 1) *
    span) as LogicalTime;
  return nextKnownEvent !== null && nextKnownEvent < limit
    ? nextKnownEvent
    : limit;
}

/** Half-open: `start` is inside, `end` is outside. */
export type Interval = Readonly<{ start: LogicalTime; end: LogicalTime }>;

export type IntervalError = Readonly<{
  code: "empty_interval";
  start: LogicalTime;
  end: LogicalTime;
}>;

export function interval(
  start: LogicalTime,
  end: LogicalTime,
): Result<Interval, IntervalError> {
  return end > start
    ? ok({ start, end })
    : err({ code: "empty_interval", start, end });
}

export function intervalContains(span: Interval, time: LogicalTime): boolean {
  return time >= span.start && time < span.end;
}

export function intervalsOverlap(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}
