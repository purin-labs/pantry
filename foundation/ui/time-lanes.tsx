import React from "react";
import { ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import "./time-lanes.css";

/**
 * Items of a day, a week or a month on a time axis, in sections of lanes. Each item is a bar
 * from its start to its end in the colour of whoever held it, its avatar, its
 * title and a short suffix. Time that waits for a person is hatched. A line
 * joins an item to the item that started it. The details of an item show in
 * a card on hover, focus or click.
 *
 * A drag, a sideways scroll or the arrow keys move the time window; a pinch,
 * Ctrl + wheel or plus and minus zoom it, from one hour to the whole period.
 * The caller holds the window, so it can offer a way back to the fitted period.
 */

/** A window of time on the axis: its start and its end. */
export type TimeRange = readonly [number, number];

export type TimeLanesTone =
  "violet" | "blue" | "green" | "coral" | "red" | "grey";

export type TimeLanesStep = Readonly<{
  /** Null for a step that holds now. */
  at: number | null;
  /** The words for a time that the record gives only as a day. */
  label?: string;
  text: string;
  tone: "info" | "wait" | "failed" | "done";
}>;

export type TimeLanesItem = Readonly<{
  id: string;
  section: string;
  start: number;
  /** The last known time, or now for an item that is still open. */
  end: number;
  title: string;
  /** A title the caller made up, which shows in a quieter style. */
  untitled: boolean;
  suffix: string | null;
  suffixTone: TimeLanesTone | null;
  tone: TimeLanesTone;
  /** A letter in a rounded square, or a person in a circle. */
  avatar: Readonly<{ tone: TimeLanesTone; letter: string | null }>;
  /** Spans that wait for a person; they show hatched over the bar. */
  waits: readonly Readonly<{ from: number; to: number | null }>[];
  /** The item that started this one, joined by a line. */
  parent: string | null;
  /** A settled item draws quieter, so open work stands out. */
  muted: boolean;
  /**
   * A repeat in a series, such as the third hourly run: its label is the
   * suffix alone, so the series fits one lane. Its card keeps the title.
   */
  quiet?: boolean;
  card: Readonly<{
    meta: string;
    steps: readonly TimeLanesStep[];
    note: string | null;
    action: Readonly<{ label: string; run: () => void }> | null;
  }>;
}>;

export type TimeLanesSection = Readonly<{
  key: string;
  name: string;
  /** A section that needs a person; its name shows in the person colour. */
  emphasis: boolean;
}>;

export type TimeLanesProps = Readonly<{
  label: string;
  sections: readonly TimeLanesSection[];
  items: readonly TimeLanesItem[];
  /** The period the axis may show. */
  bounds: TimeRange;
  now: number | null;
  /** The window in view, or null to fit the period. */
  range: TimeRange | null;
  onRange: (range: TimeRange) => void;
  legend: React.ReactNode;
  /** The card's words for a link, for a timeline that draws links. */
  linkWords?: Readonly<{ parent: string; child: string }>;
}>;

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
/** The narrowest window a zoom shows. The widest is the whole period. */
const MIN_RANGE = HOUR;
/** A period longer than this reads in dates, not in the hours of one day. */
const ONE_DAY_LIMIT = 26 * HOUR;
/** A window longer than this has a tick for each day, not for each hour. */
const DAY_TICKS_FROM = 3 * DAY;
/** The longest title in a week or a month; its card holds the whole title. */
const WIDE_TITLE = 220;

/** Where the plot starts, at the rule after the section names. */
const LEFT = 156;
/** The room a label keeps from the end of the period. */
const LABEL_MARGIN = 12;
/** Where a section name starts, with the key above on the same edge. */
const SECTION_X = 16;
const AXIS = 40;
const LANE = 40;
const SECTION_PAD = 8;
const BAR = 22;
const AVATAR = 20;
const GAP = 7;
const MIN_BAR = 7;
const CARD_WIDTH = 320;
const TITLE_FONT = "500 12.5px Inter, ui-sans-serif, system-ui, sans-serif";
const SUFFIX_FONT = "600 12px Inter, ui-sans-serif, system-ui, sans-serif";
const SECTION_FONT = "600 13px Inter, ui-sans-serif, system-ui, sans-serif";
const SPANS: readonly TimeSpan[] = ["day", "week", "month"];
const NO_LINK_WORDS = { parent: "After", child: "Then" };
const SPAN_NAME: Record<TimeSpan, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${String(minutes)} min`;
  if (minutes < 24 * 60)
    return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(minutes / (24 * 60)))}d ${String(Math.floor(minutes / 60) % 24)}h`;
}

/** The time alone in a day; with its date in a longer period. */
export function timeIn(bounds: TimeRange, at: number): string {
  if (bounds[1] - bounds[0] <= ONE_DAY_LIMIT) return hhmm(at);
  return `${monthDay(at)} ${hhmm(at)}`;
}

function monthDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** "Mon 2": a language's own order would write "2 Mon" in English. */
function weekdayDay(at: number): string {
  const date = new Date(at);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${String(date.getDate())}`;
}

/** How much a timeline shows at one time. */
export type TimeSpan = "day" | "week" | "month";

/** The period a timeline shows: its length, its start and its end. */
export type TimePeriod = Readonly<{ span: TimeSpan; from: number; to: number }>;

/** The period in view and the ways to change it. */
export type PeriodControl = Readonly<{
  period: TimePeriod;
  onSpan: (span: TimeSpan) => void;
  /** To the period before, or to the period after. */
  onStep: (by: -1 | 1) => void;
  /** To the next longer span, unless a person chose the period. */
  widen: (from: TimeSpan) => void;
}>;

/** The period of a length that holds a time. A week starts on Monday. */
function periodOf(span: TimeSpan, at: number): TimePeriod {
  const day = startOfDay(at);
  const date = new Date(day);
  switch (span) {
    case "day":
      return { span, from: day, to: nextDay(day) };
    case "week": {
      const from = shiftDay(day, -((date.getDay() + 6) % 7));
      return { span, from, to: shiftDay(from, 7) };
    }
    case "month":
      return {
        span,
        from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
        to: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
      };
  }
}

/** The time now, if the period holds it. */
export function nowIn(period: TimePeriod, now: number): number | null {
  return period.from <= now && now < period.to ? now : null;
}

/** The period the caller reads, which starts as the day of `at`. */
export function usePeriod(
  at: number = Date.now(),
  span: TimeSpan = "day",
): PeriodControl {
  // A step that comes back to the period of the first day shows that day, so
  // that a shorter span then opens today and not the first day of a month.
  const [home] = React.useState(at);
  const [state, setState] = React.useState<
    Readonly<{ span: TimeSpan; at: number; chosen: boolean }>
  >({ span, at, chosen: false });
  const period = periodOf(state.span, state.at);
  const onSpan = React.useCallback(
    (span: TimeSpan) =>
      setState((current) => ({ ...current, span, chosen: true })),
    [],
  );
  const onStep = React.useCallback(
    (by: -1 | 1) =>
      setState((current) => {
        const { span, from } = periodOf(current.span, current.at);
        const date = new Date(from);
        const next =
          span === "day"
            ? shiftDay(from, by)
            : span === "week"
              ? shiftDay(from, 7 * by)
              : new Date(date.getFullYear(), date.getMonth() + by, 1).getTime();
        const back = nowIn(periodOf(span, next), home) !== null;
        return { ...current, at: back ? home : next, chosen: true };
      }),
    [home],
  );
  const widen = React.useCallback(
    (from: TimeSpan) =>
      setState((current) =>
        current.chosen || current.span !== from || from === "month"
          ? current
          : { ...current, span: from === "day" ? "week" : "month" },
      ),
    [],
  );
  return React.useMemo(
    () => ({ period, onSpan, onStep, widen }),
    // The period is a new object on each render; its values name it.
    [period.span, period.from, period.to, onSpan, onStep, widen],
  );
}

/**
 * Opens on a longer span when the day holds nothing, so that a quiet shop sees
 * its week or its month and not an empty page. `read` names the window that the
 * caller read, because an earlier read is not an answer about this period.
 */
export function useWiderWhenEmpty(
  control: PeriodControl,
  read: Readonly<{ from: number; to: number }> | null,
  empty: boolean,
): void {
  const { period, widen } = control;
  const current =
    read !== null && read.from === period.from && read.to === period.to;
  React.useEffect(() => {
    if (current && empty) widen(period.span);
  }, [current, empty, period.span, widen]);
}

/** The words of a timeline: "this week", or "in October 2026" for another. */
export function periodWords(period: TimePeriod): string {
  if (nowIn(period, Date.now()) !== null) return `this ${period.span}`;
  switch (period.span) {
    case "day":
      return `on ${monthDay(period.from)}`;
    case "week":
      return `in the week of ${monthDay(period.from)}`;
    case "month":
      return `in ${new Date(period.from).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })}`;
  }
}

/** The length to show, and the period with a step before and after it. */
export function PeriodPicker(props: {
  readonly control: PeriodControl;
  /** The time now, if the period holds it. */
  readonly now: number | null;
  /** Lets the arrows pass today, for records that are still to come. */
  readonly future?: boolean;
}): React.ReactNode {
  const { period, onSpan, onStep } = props.control;
  return (
    <>
      <span className="time-lanes-spans" role="group" aria-label="Show">
        {SPANS.map((span) => (
          <button
            key={span}
            type="button"
            aria-pressed={period.span === span}
            onClick={() => onSpan(span)}
          >
            {SPAN_NAME[span]}
          </button>
        ))}
      </span>
      <span className="time-lanes-day">
        <button
          type="button"
          className="time-lanes-step"
          aria-label={`The ${period.span} before`}
          onClick={() => onStep(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <b>{periodLabel(period, props.now !== null)}</b>
        <button
          type="button"
          className="time-lanes-step"
          aria-label={`The ${period.span} after`}
          disabled={props.now !== null && props.future !== true}
          onClick={() => onStep(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </span>
    </>
  );
}

/** The way back to the whole period after a pan or a zoom. */
export function FitPeriod(props: {
  readonly span: TimeSpan;
  readonly fitted: boolean;
  readonly onFit: () => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      className="secondary time-lanes-fit"
      aria-pressed={props.fitted}
      title="Drag or scroll sideways to move in time. Pinch or Ctrl + scroll to zoom."
      onClick={props.onFit}
    >
      Fit {props.span}
    </button>
  );
}

function shiftDay(day: number, by: number): number {
  const date = new Date(day);
  date.setDate(date.getDate() + by);
  return date.getTime();
}

/** The next local midnight, which a day of daylight saving keeps right. */
function nextDay(day: number): number {
  return shiftDay(day, 1);
}

export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function periodLabel(period: TimePeriod, current: boolean): string {
  switch (period.span) {
    case "day": {
      const date = new Date(period.from).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
      return current ? `Today · ${date}` : date;
    }
    case "week": {
      const first = new Date(period.from);
      const last = new Date(shiftDay(period.to, -1));
      const days =
        first.getMonth() === last.getMonth()
          ? `${monthDay(period.from)} – ${String(last.getDate())}`
          : `${monthDay(period.from)} – ${monthDay(last.getTime())}`;
      return current ? `This week · ${days}` : days;
    }
    case "month": {
      const month = new Date(period.from).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
      return current ? `This month · ${month}` : month;
    }
  }
}

/**
 * The window in view after a pan or a zoom, for one period; null fits the
 * period. A window belongs to its period, so another period starts fitted.
 */
export function usePeriodRange(
  period: TimePeriod,
): readonly [TimeRange | null, (range: TimeRange | null) => void] {
  const key = `${String(period.from)}:${String(period.to)}`;
  const [view, setView] = React.useState<Readonly<{
    key: string;
    range: TimeRange;
  }> | null>(null);
  const range = view !== null && view.key === key ? view.range : null;
  const set = React.useCallback(
    (next: TimeRange | null) =>
      setView(next === null ? null : { key, range: next }),
    [key],
  );
  return [range, set];
}

/** The key above the lanes: each owner's avatar, and the link. */
export function TimeLanesKey(props: {
  readonly owners: readonly Readonly<{
    tone: TimeLanesTone;
    letter: string | null;
    name: string;
  }>[];
  readonly link: string | null;
}): React.ReactNode {
  return (
    <ul className="time-lanes-key" aria-label="Key">
      {props.owners.map((owner) => (
        <li key={owner.name}>
          <i
            data-tone={owner.tone}
            data-shape={owner.letter === null ? "person" : undefined}
          >
            {owner.letter ?? <UserRound size={10} aria-hidden="true" />}
          </i>
          {owner.name}
        </li>
      ))}
      {props.link === null ? null : (
        <li className="time-lanes-key-link">
          <span aria-hidden="true" />
          {props.link}
        </li>
      )}
    </ul>
  );
}

/* ---------- layout ---------- */

type Placed = Readonly<{
  item: TimeLanesItem;
  /** The title the label shows, which a week or a month may shorten. */
  title: string;
  mid: number;
  x0: number;
  x1: number;
  /** Where the avatar, title and suffix start, and their width. */
  labelX: number;
  labelWidth: number;
  titleWidth: number;
}>;

type Geometry = Readonly<{
  width: number;
  height: number;
  tx: (at: number) => number;
  /** The time at an x in the stage, for a pan or a zoom. */
  at: (x: number) => number;
  ticks: readonly number[];
  sections: readonly Readonly<{
    key: string;
    name: string;
    emphasis: boolean;
    top: number;
    height: number;
    count: number;
  }>[];
  placed: readonly Placed[];
}>;

let measureContext: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (measureContext === null) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * The hours the items span, at least eight, inside a day's bounds. A week or a
 * month shows all of its days, so that the view reads as a calendar.
 */
function fitRange(
  items: readonly TimeLanesItem[],
  bounds: TimeRange,
  now: number | null,
): TimeRange {
  const [from, to] = bounds;
  if (to - from > ONE_DAY_LIMIT) return bounds;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    first = Math.min(first, item.start);
    last = Math.max(last, item.end);
  }
  // Room after now for the titles of the items that are still open.
  if (now !== null) last = Math.max(last, now + 4 * HOUR);
  let start = Math.max(from, Math.floor((first - from) / HOUR) * HOUR + from);
  let end = Math.min(to, Math.ceil((last - from) / HOUR) * HOUR + from);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    start = from + 7 * HOUR;
    end = from + 19 * HOUR;
  }
  while (end - start < 8 * HOUR) {
    if (end < to) end += HOUR;
    else if (start > from) start -= HOUR;
    else break;
  }
  return [start, end];
}

/** Tick steps, in minutes, from the finest; a tick needs 64 px. */
const TICK_STEPS = [15, 30, 60, 120, 180, 360] as const;
/** Tick steps, in days, from the finest; a date needs 48 px. */
const DAY_TICK_STEPS = [1, 2, 7] as const;

/** The ticks of a window: at local times, so a clock change keeps them right. */
function ticksOf(
  range: TimeRange,
  bounds: TimeRange,
  plot: number,
): readonly number[] {
  const [start, end] = range;
  const ticks: number[] = [];
  if (end - start > DAY_TICKS_FROM) {
    const perDay = plot / ((end - start) / DAY);
    const step = DAY_TICK_STEPS.find((days) => days * perDay >= 48) ?? 7;
    for (
      let tick = bounds[0], index = 0;
      tick <= end;
      index += step, tick = shiftDay(bounds[0], index)
    )
      if (tick >= start) ticks.push(tick);
    return ticks;
  }
  const perMinute = plot / ((end - start) / MINUTE);
  const step =
    (TICK_STEPS.find((minutes) => minutes * perMinute >= 64) ?? 360) * MINUTE;
  for (let day = startOfDay(start); day <= end; day = nextDay(day))
    for (
      let tick = day + Math.max(Math.ceil((start - day) / step), 0) * step;
      tick < nextDay(day) && tick <= end;
      tick += step
    )
      ticks.push(tick);
  return ticks;
}

/** A tick's words: a date for a day, the time for an hour inside a day. */
function tickLabel(at: number, range: TimeRange, bounds: TimeRange): string {
  const span = range[1] - range[0];
  if (span <= DAY_TICKS_FROM)
    return at === startOfDay(at) && bounds[1] - bounds[0] > ONE_DAY_LIMIT
      ? weekdayDay(at)
      : hhmm(at);
  return bounds[1] - bounds[0] > 8 * DAY ? monthDay(at) : weekdayDay(at);
}

function layout(
  props: TimeLanesProps,
  width: number,
  range: TimeRange,
  fit: TimeRange,
): Geometry {
  const [start, end] = range;
  const plot = width - LEFT;
  // Times outside the window fall outside the plot, which clips them.
  const tx = (at: number): number =>
    LEFT + ((at - start) / (end - start)) * plot;
  const at = (x: number): number => start + ((x - LEFT) / plot) * (end - start);
  const ticks = ticksOf(range, props.bounds, plot);
  const wide = props.bounds[1] - props.bounds[0] > ONE_DAY_LIMIT;
  // A label flips before its bar at the edge of the fitted period, not of the
  // view, so a pan moves the lanes and never repacks them.
  const rightEdge = tx(fit[1]) - LABEL_MARGIN;
  const leftEdge = tx(fit[0]);
  const placed: Placed[] = [];
  const sections: Geometry["sections"][number][] = [];
  let top = AXIS;
  for (const section of props.sections) {
    const items = props.items
      .filter((item) => item.section === section.key)
      .sort((left, right) => left.start - right.start);
    if (items.length === 0) continue;
    // Each lane keeps the right edge of what it holds; an item takes the
    // first lane it fits in, label included.
    const lanes: number[] = [];
    const rows: { entry: Omit<Placed, "mid">; lane: number }[] = [];
    for (const item of items) {
      const x0 = tx(item.start);
      const x1 = Math.max(tx(item.end), x0 + MIN_BAR);
      const quiet = item.quiet === true;
      const title = wide
        ? shorten(item.title, WIDE_TITLE, TITLE_FONT)
        : item.title;
      const titleWidth = quiet ? 0 : measure(title, TITLE_FONT);
      const suffixWidth =
        item.suffix === null ? 0 : measure(item.suffix, SUFFIX_FONT);
      const labelWidth = quiet
        ? suffixWidth
        : AVATAR + GAP + titleWidth + (suffixWidth === 0 ? 0 : 8 + suffixWidth);
      // A label that would leave the timeline sits before its bar instead.
      const after = x1 + 6;
      const labelX =
        after + labelWidth <= rightEdge || x0 - 6 - labelWidth < leftEdge
          ? after
          : x0 - 6 - labelWidth;
      // A mark with no label needs no room for one, so a series keeps its lane.
      const left = labelWidth === 0 ? x0 - 1 : Math.min(x0, labelX) - 6;
      const right =
        labelWidth === 0 ? x1 + 1 : Math.max(x1, labelX + labelWidth) + 14;
      let lane = lanes.findIndex((edge) => edge <= left);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(right);
      } else lanes[lane] = right;
      rows.push({
        lane,
        entry: { item, title, x0, x1, labelX, labelWidth, titleWidth },
      });
    }
    const height = SECTION_PAD * 2 + Math.max(lanes.length, 1) * LANE;
    for (const row of rows)
      placed.push({
        ...row.entry,
        mid: top + SECTION_PAD + row.lane * LANE + LANE / 2,
      });
    sections.push({
      key: section.key,
      // A long name stops before the rule, with room for its count.
      name: shorten(
        section.name,
        LEFT - SECTION_X - 14 - measure(String(items.length), SECTION_FONT),
        SECTION_FONT,
      ),
      emphasis: section.emphasis,
      top,
      height,
      count: items.length,
    });
    top += height;
  }
  return { width, height: top, tx, at, ticks, sections, placed };
}

/** How near two bars are, in px, for a link to run straight between them. */
const STACKED = 24;

/**
 * An Asana-style link from the item that started another: it leaves the
 * parent bar's edge, bends smoothly and enters the child from the left. Two
 * bars at nearly one time have no room for a bend, so the link runs from the
 * end of one bar to the end of the other.
 */
function linkPath(
  parent: Placed,
  child: Placed,
): Readonly<{
  d: string;
  head: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}> {
  const towards = (tx: number, ty: number): string =>
    `M${f(tx - 7)} ${f(ty - 4.5)} L${f(tx)} ${f(ty)} L${f(tx - 7)} ${f(ty + 4.5)} Z`;
  if (child.mid !== parent.mid && Math.abs(child.x0 - parent.x0) < STACKED) {
    const dir = child.mid > parent.mid ? 1 : -1;
    const sx = (parent.x0 + parent.x1) / 2;
    const sy = parent.mid + (dir * BAR) / 2;
    const tx = (child.x0 + child.x1) / 2;
    const ty = child.mid - (dir * BAR) / 2;
    const middle = (sy + ty) / 2;
    return {
      d: `M${f(sx)} ${f(sy)} C${f(sx)} ${f(middle)} ${f(tx)} ${f(middle)} ${f(tx)} ${f(ty - dir * 6)}`,
      head: `M${f(tx - 4)} ${f(ty - dir * 6)} L${f(tx)} ${f(ty)} L${f(tx + 4)} ${f(ty - dir * 6)} Z`,
      sx,
      sy,
      tx,
      ty,
    };
  }
  // In one lane the link runs straight on from the end of the parent's
  // label, so it never crosses that label.
  const after = Math.max(parent.x1, parent.labelX + parent.labelWidth) + 6;
  if (child.mid === parent.mid && after < child.x0 - 14) {
    const ty = child.mid;
    const tx = child.x0 - 2;
    return {
      d: `M${f(after)} ${f(ty)} L${f(tx - 6)} ${f(ty)}`,
      head: towards(tx, ty),
      sx: after,
      sy: ty,
      tx,
      ty,
    };
  }
  const dir = child.mid > parent.mid ? 1 : -1;
  const sx = Math.min(
    Math.max(child.x0 - 16, parent.x0 + 3),
    Math.max(parent.x0 + 3, parent.x1 - 3),
  );
  const sy = parent.mid + (dir * BAR) / 2;
  const tx = child.x0 - 2;
  const ty = child.mid;
  const bend = Math.max(Math.min((tx - sx) * 0.65, 140), 18);
  const d = `M${f(sx)} ${f(sy)} C${f(sx)} ${f(sy + dir * Math.abs(ty - sy) * 0.75)} ${f(tx - bend)} ${f(ty)} ${f(tx - 6)} ${f(ty)}`;
  return { d, head: towards(tx, ty), sx, sy, tx, ty };
}

function f(value: number): string {
  return value.toFixed(1);
}

/** The window moved by a time, held inside the bounds. */
function pan(range: TimeRange, by: number, bounds: TimeRange): TimeRange {
  const span = range[1] - range[0];
  const from = Math.min(Math.max(range[0] + by, bounds[0]), bounds[1] - span);
  return [from, from + span];
}

/** The window at a new length, with the time `at` held where it was. */
function zoom(
  range: TimeRange,
  at: number,
  length: number,
  bounds: TimeRange,
): TimeRange {
  const span = Math.min(Math.max(length, MIN_RANGE), bounds[1] - bounds[0]);
  const share = (at - range[0]) / (range[1] - range[0]);
  return pan([at - share * span, at - share * span + span], 0, bounds);
}

/* ---------- drawing ---------- */

type Shown = Readonly<{ id: string; pinned: boolean }>;

/** Safari's trackpad pinch, which it does not send as a Ctrl + wheel. */
type GestureEvent = Event & {
  readonly scale: number;
  readonly clientX: number;
};

export function TimeLanes(props: TimeLanesProps): React.ReactNode {
  const frame = React.useRef<HTMLDivElement | null>(null);
  const stage = React.useRef<HTMLDivElement | null>(null);
  const plotClip = React.useId();
  const width = useWidth(frame);
  const fit = fitRange(props.items, props.bounds, props.now);
  const range = props.range ?? fit;
  const geometry =
    width === 0 ? null : layout(props, Math.max(width, 560), range, fit);
  const [shown, setShown] = React.useState<Shown | null>(null);
  const [panning, setPanning] = React.useState(false);
  // The handlers below outlive a render; they read the latest window here.
  const latest = React.useRef({
    range,
    geometry,
    bounds: props.bounds,
    onRange: props.onRange,
  });
  latest.current = {
    range,
    geometry,
    bounds: props.bounds,
    onRange: props.onRange,
  };
  const bounds = props.bounds;
  // The frame scrolls sideways, so it clips a card below its last row. It
  // grows to the bottom of an open card instead.
  const [cardBottom, setCardBottom] = React.useState(0);
  const byId = new Map(
    geometry?.placed.map((entry) => [entry.item.id, entry]) ?? [],
  );
  const links =
    geometry?.placed.flatMap((child) => {
      const parent =
        child.item.parent === null ? undefined : byId.get(child.item.parent);
      return parent === undefined ? [] : [{ parent, child }];
    }) ?? [];
  const active = shown === null ? undefined : byId.get(shown.id);
  // A card closes a moment after the pointer leaves, so the pointer can
  // reach it.
  const closing = React.useRef<number | null>(null);
  const keep = (): void => {
    if (closing.current !== null) window.clearTimeout(closing.current);
    closing.current = null;
  };
  React.useEffect(() => keep, []);
  const show = (id: string): void => {
    keep();
    setShown((current) =>
      current?.pinned === true ? current : { id, pinned: false },
    );
  };
  const hide = (id: string): void => {
    keep();
    closing.current = window.setTimeout(() => {
      closing.current = null;
      setShown((current) =>
        current?.pinned === true || current?.id !== id ? current : null,
      );
    }, 160);
  };
  const pin = (id: string): void =>
    setShown((current) =>
      current?.pinned === true && current.id === id
        ? null
        : { id, pinned: true },
    );

  // Pan and zoom. A drag moves the window; a second finger, a pinch or a
  // Ctrl + wheel zooms it around the pointer. A drag that moved swallows the
  // click that ends it, so it does not pin the item under the pointer.
  const pointers = React.useRef(new Map<number, number>());
  const drag = React.useRef<{
    x: number;
    range: TimeRange;
    moved: boolean;
  } | null>(null);
  const pinch = React.useRef<{
    distance: number;
    range: TimeRange;
    at: number;
  } | null>(null);
  const swallow = React.useRef(false);
  const stageX = (clientX: number): number =>
    clientX - (stage.current?.getBoundingClientRect().left ?? 0);
  React.useEffect(() => {
    const element = frame.current;
    if (element === null) return undefined;
    const zoomAround = (clientX: number, factor: number): void => {
      const { geometry: shape, range: current } = latest.current;
      if (shape === null) return;
      const x = stageX(clientX);
      const at = x < LEFT ? current[0] : shape.at(x);
      latest.current.onRange(
        zoom(
          current,
          at,
          (current[1] - current[0]) * factor,
          latest.current.bounds,
        ),
      );
    };
    const onWheel = (event: WheelEvent): void => {
      const { geometry: shape, range: current } = latest.current;
      if (shape === null) return;
      const unit = event.deltaMode === 1 ? 16 : 1;
      // A trackpad pinch sends many small deltas; a wheel notch sends one
      // large one, which zooms by a quarter at most.
      if (event.ctrlKey) {
        event.preventDefault();
        setShown(null);
        zoomAround(
          event.clientX,
          Math.min(Math.max(Math.exp(event.deltaY * unit * 0.01), 0.8), 1.25),
        );
        return;
      }
      const sideways =
        event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      if (sideways === 0 || Math.abs(sideways) < Math.abs(event.deltaY)) return;
      event.preventDefault();
      setShown(null);
      const perPixel = (current[1] - current[0]) / (shape.width - LEFT);
      latest.current.onRange(
        pan(current, sideways * unit * perPixel, latest.current.bounds),
      );
    };
    let gesture: { range: TimeRange; at: number } | null = null;
    const onGestureStart = (raw: Event): void => {
      const event = raw as GestureEvent;
      const { geometry: shape, range: current } = latest.current;
      if (shape === null) return;
      event.preventDefault();
      const x = stageX(event.clientX);
      gesture = { range: current, at: x < LEFT ? current[0] : shape.at(x) };
    };
    const onGestureChange = (raw: Event): void => {
      const event = raw as GestureEvent;
      if (gesture === null) return;
      event.preventDefault();
      setShown(null);
      latest.current.onRange(
        zoom(
          gesture.range,
          gesture.at,
          (gesture.range[1] - gesture.range[0]) / event.scale,
          latest.current.bounds,
        ),
      );
    };
    const onGestureEnd = (): void => {
      gesture = null;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.current.set(event.pointerId, event.clientX);
    if (pointers.current.size === 1) {
      drag.current = { x: event.clientX, range, moved: false };
      return;
    }
    const [first, second] = [...pointers.current.values()];
    if (geometry === null || first === undefined || second === undefined)
      return;
    drag.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = stageX((first + second) / 2);
    pinch.current = {
      distance: Math.max(Math.abs(first - second), 24),
      range,
      at: x < LEFT ? range[0] : geometry.at(x),
    };
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!pointers.current.has(event.pointerId) || geometry === null) return;
    pointers.current.set(event.pointerId, event.clientX);
    const zooming = pinch.current;
    if (zooming !== null) {
      const [first, second] = [...pointers.current.values()];
      if (first === undefined || second === undefined) return;
      const distance = Math.max(Math.abs(first - second), 24);
      props.onRange(
        zoom(
          zooming.range,
          zooming.at,
          ((zooming.range[1] - zooming.range[0]) * zooming.distance) / distance,
          bounds,
        ),
      );
      return;
    }
    const moving = drag.current;
    if (moving === null) return;
    const dx = event.clientX - moving.x;
    if (!moving.moved) {
      if (Math.abs(dx) < 4) return;
      moving.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
      setShown(null);
    }
    const perPixel =
      (moving.range[1] - moving.range[0]) / (geometry.width - LEFT);
    props.onRange(pan(moving.range, -dx * perPixel, bounds));
  };
  const onPointerEnd = (event: React.PointerEvent<SVGSVGElement>): void => {
    pointers.current.delete(event.pointerId);
    if (drag.current?.moved === true || pinch.current !== null) {
      swallow.current = true;
      window.setTimeout(() => {
        swallow.current = false;
      }, 0);
    }
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    setPanning(false);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      setShown(null);
      return;
    }
    if (geometry === null || event.altKey || event.metaKey || event.ctrlKey)
      return;
    const span = range[1] - range[0];
    const middle = (range[0] + range[1]) / 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onRange(
        pan(range, (event.key === "ArrowLeft" ? -1 : 1) * span * 0.125, bounds),
      );
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      props.onRange(zoom(range, middle, span * 0.8, bounds));
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      props.onRange(zoom(range, middle, span * 1.25, bounds));
    }
  };
  // A keyboard user who reaches an item outside the window brings it in.
  const reveal = (entry: Placed): void => {
    if (geometry === null) return;
    if (entry.x0 >= LEFT && entry.x0 <= geometry.width - 24) return;
    const span = range[1] - range[0];
    const from = entry.item.start - span * 0.3;
    props.onRange(pan([from, from + span], 0, bounds));
  };
  return (
    <div className="time-lanes" ref={frame} onKeyDown={onKeyDown}>
      {props.legend}
      {geometry === null ? null : (
        <div
          ref={stage}
          className={`time-lanes-stage${panning ? " is-panning" : ""}`}
          style={{
            width: geometry.width,
            minHeight:
              active === undefined
                ? undefined
                : Math.max(geometry.height, cardBottom),
          }}
        >
          <svg
            className="time-lanes-canvas"
            width={geometry.width}
            height={geometry.height}
            viewBox={`0 0 ${String(geometry.width)} ${String(geometry.height)}`}
            role="group"
            tabIndex={0}
            aria-label={`${props.label}. Arrow keys move in time; plus and minus zoom.`}
            aria-keyshortcuts="ArrowLeft ArrowRight + -"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onClickCapture={(event) => {
              if (!swallow.current) return;
              swallow.current = false;
              event.stopPropagation();
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) setShown(null);
            }}
          >
            <defs>
              <clipPath id={plotClip}>
                <rect
                  x={LEFT}
                  y={0}
                  width={geometry.width - LEFT}
                  height={geometry.height}
                />
              </clipPath>
            </defs>
            <Backdrop
              geometry={geometry}
              now={props.now}
              plotClip={plotClip}
              range={range}
              bounds={props.bounds}
            />
            <g clipPath={`url(#${plotClip})`}>
              {links.map(({ parent, child }) => {
                const path = linkPath(parent, child);
                const on =
                  active !== undefined &&
                  (active === parent || active === child);
                return (
                  <g
                    key={child.item.id}
                    className={`time-lanes-link${on ? " is-on" : ""}`}
                    aria-hidden="true"
                  >
                    <path className="time-lanes-link-line" d={path.d} />
                    <path className="time-lanes-link-head" d={path.head} />
                    <circle
                      className="time-lanes-link-start"
                      cx={path.sx}
                      cy={path.sy}
                      r={3.5}
                    />
                  </g>
                );
              })}
              {geometry.placed.map((entry) => (
                <Item
                  key={entry.item.id}
                  entry={entry}
                  geometry={geometry}
                  now={props.now}
                  active={entry === active}
                  pinned={entry === active && shown?.pinned === true}
                  onShow={() => show(entry.item.id)}
                  onHide={() => hide(entry.item.id)}
                  onPin={() => pin(entry.item.id)}
                  onReveal={() => reveal(entry)}
                />
              ))}
            </g>
          </svg>
          {active === undefined ? null : (
            <Card
              entry={active}
              geometry={geometry}
              byId={byId}
              now={props.now}
              bounds={props.bounds}
              linkWords={props.linkWords ?? NO_LINK_WORDS}
              onKeep={() => show(active.item.id)}
              onLeave={() => hide(active.item.id)}
              onBottom={setCardBottom}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Backdrop(props: {
  readonly geometry: Geometry;
  readonly now: number | null;
  readonly plotClip: string;
  readonly range: TimeRange;
  readonly bounds: TimeRange;
}): React.ReactNode {
  const { geometry } = props;
  const nowX = props.now === null ? null : geometry.tx(props.now);
  return (
    <g aria-hidden="true">
      <g clipPath={`url(#${props.plotClip})`}>
        {nowX === null ? null : (
          <rect
            className="time-lanes-future"
            x={nowX}
            y={AXIS}
            width={Math.max(geometry.width - nowX, 0)}
            height={geometry.height - AXIS}
          />
        )}
        {geometry.ticks.map((at) => {
          const x = geometry.tx(at);
          // A tick label is about 36 px wide; the now pill covers 26 px each
          // side. A label that the right edge would cut stays off. The rule
          // and the card's edge draw the lines at the ends of the plot.
          const nearNow = nowX !== null && x > nowX - 72 && x < nowX + 32;
          const inside = x > LEFT + 1 && x < geometry.width - 1;
          return (
            <g key={at}>
              {inside ? (
                <line
                  className="time-lanes-grid"
                  x1={x}
                  x2={x}
                  y1={AXIS}
                  y2={geometry.height}
                />
              ) : null}
              {nearNow || x + 44 > geometry.width ? null : (
                <text className="time-lanes-axis" x={x + 5} y={25}>
                  {tickLabel(at, props.range, props.bounds)}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <line
        className="time-lanes-rule"
        x1={0}
        x2={geometry.width}
        y1={AXIS}
        y2={AXIS}
      />
      <line
        className="time-lanes-rule"
        x1={LEFT}
        x2={LEFT}
        y1={0}
        y2={geometry.height}
      />
      {geometry.sections.map((section, index) => (
        <g key={section.key}>
          {index === 0 ? null : (
            <line
              className="time-lanes-rule"
              x1={0}
              x2={geometry.width}
              y1={section.top}
              y2={section.top}
            />
          )}
          <text
            className={`time-lanes-section${section.emphasis ? " is-emphasis" : ""}`}
            x={SECTION_X}
            y={section.top + SECTION_PAD + LANE / 2 + 4.5}
          >
            {section.name}
            <tspan className="time-lanes-section-count" dx={8}>
              {section.count}
            </tspan>
          </text>
        </g>
      ))}
      {nowX === null || props.now === null ? null : (
        <g clipPath={`url(#${props.plotClip})`}>
          <line
            className="time-lanes-now"
            x1={nowX}
            x2={nowX}
            y1={30}
            y2={geometry.height}
          />
          <rect
            className="time-lanes-now-pill"
            x={nowX - 26}
            y={10}
            width={52}
            height={20}
            rx={10}
          />
          <text
            className="time-lanes-now-text"
            x={nowX}
            y={24}
            textAnchor="middle"
          >
            {props.range[1] - props.range[0] > 8 * DAY
              ? monthDay(props.now)
              : hhmm(props.now)}
          </text>
        </g>
      )}
    </g>
  );
}

function Item(props: {
  readonly entry: Placed;
  readonly geometry: Geometry;
  readonly now: number | null;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onPin: () => void;
  readonly onReveal: () => void;
}): React.ReactNode {
  const { entry, geometry, now } = props;
  const { item, mid, x0, x1 } = entry;
  const clip = React.useId();
  const hatch = React.useId();
  const label = visibleLabel(entry);
  const quiet = item.quiet === true;
  const titleX = (label?.x ?? 0) + (quiet ? 0 : AVATAR + GAP);
  const nowX = now === null ? null : geometry.tx(now);
  const backed =
    label !== null &&
    nowX !== null &&
    nowX > label.x - 4 &&
    nowX < label.x + label.width + 4;
  return (
    <g
      className={`time-lanes-item${item.muted ? " is-muted" : ""}${props.active ? " is-active" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Show details of ${item.title}${item.suffix === null ? "" : `, ${item.suffix}`}`}
      aria-expanded={props.pinned}
      onMouseEnter={props.onShow}
      onMouseLeave={props.onHide}
      onFocus={() => {
        props.onReveal();
        props.onShow();
      }}
      onBlur={props.onHide}
      onClick={props.onPin}
      onKeyDown={(key) => {
        if (key.key === "Enter" || key.key === " ") {
          key.preventDefault();
          props.onPin();
        }
      }}
    >
      <rect
        className="time-lanes-hit"
        x={Math.min(x0, entry.labelX) - 4}
        y={mid - LANE / 2}
        width={
          Math.max(x1, entry.labelX + entry.labelWidth) -
          Math.min(x0, entry.labelX) +
          8
        }
        height={LANE}
      />
      <clipPath id={clip}>
        <rect x={x0} y={mid - BAR / 2} width={x1 - x0} height={BAR} rx={5} />
      </clipPath>
      {/* Time that waits for a person is hatched, so it reads as idle. */}
      <pattern
        id={hatch}
        width={6}
        height={6}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect className="time-lanes-hatch" width={2.5} height={6} />
      </pattern>
      <g className="time-lanes-bar" clipPath={`url(#${clip})`}>
        <rect
          className="time-lanes-seg"
          data-tone={item.tone}
          x={x0}
          y={mid - BAR / 2}
          width={x1 - x0}
          height={BAR}
        />
        {item.waits.map((wait) => {
          const from = geometry.tx(wait.from);
          const to = geometry.tx(wait.to ?? now ?? item.end);
          const width = Math.max(to - from, 3);
          return (
            <React.Fragment key={wait.from}>
              <rect
                className="time-lanes-seg is-wait"
                x={from}
                y={mid - BAR / 2}
                width={width}
                height={BAR}
              />
              <rect
                x={from}
                y={mid - BAR / 2}
                width={width}
                height={BAR}
                fill={`url(#${hatch})`}
              />
            </React.Fragment>
          );
        })}
      </g>
      <rect
        className="time-lanes-ring"
        x={x0 - 3}
        y={mid - BAR / 2 - 3}
        width={x1 - x0 + 6}
        height={BAR + 6}
        rx={7}
      />
      {backed && label !== null ? (
        <rect
          className="time-lanes-label-back"
          x={label.x - 4}
          y={mid - 11}
          width={label.width + 8}
          height={22}
          rx={6}
        />
      ) : null}
      {label === null ? null : (
        <>
          {quiet ? null : <Avatar avatar={item.avatar} x={label.x} mid={mid} />}
          {label.title === null ? null : (
            <text
              className={`time-lanes-title${item.untitled ? " is-untitled" : ""}`}
              x={titleX}
              y={mid + 4.5}
            >
              {label.title}
            </text>
          )}
          {item.suffix === null ? null : (
            <text
              className="time-lanes-suffix"
              data-tone={item.suffixTone ?? undefined}
              x={titleX + (label.title === null ? 0 : label.titleWidth + 8)}
              y={mid + 4.5}
            >
              {item.suffix}
            </text>
          )}
        </>
      )}
    </g>
  );
}

/**
 * The label as the plot shows it. A label that the left edge of the plot
 * would cut sticks to that edge and keeps its end, so it never reaches the
 * next item of its lane: the title shortens with an ellipsis, or goes, and
 * the label goes when even the avatar and the suffix do not fit.
 */
function visibleLabel(entry: Placed): Readonly<{
  x: number;
  width: number;
  title: string | null;
  titleWidth: number;
}> | null {
  const edge = LEFT + 6;
  const end = entry.labelX + entry.labelWidth;
  if (entry.item.quiet === true)
    return entry.labelX >= edge
      ? { x: entry.labelX, width: entry.labelWidth, title: null, titleWidth: 0 }
      : null;
  if (entry.labelX >= edge || end <= edge)
    return {
      x: entry.labelX,
      width: entry.labelWidth,
      title: entry.title,
      titleWidth: entry.titleWidth,
    };
  // The suffix and the 8 px before it; 0 when the item has no suffix.
  const suffixWidth = entry.labelWidth - AVATAR - GAP - entry.titleWidth;
  const room = end - edge - AVATAR - GAP - suffixWidth;
  if (room >= 36) {
    const title = shorten(entry.title, room, TITLE_FONT);
    const titleWidth = measure(title, TITLE_FONT);
    return {
      x: edge,
      width: AVATAR + GAP + titleWidth + suffixWidth,
      title,
      titleWidth,
    };
  }
  const bare = AVATAR + GAP + Math.max(suffixWidth - 8, 0);
  if (end - edge < bare) return null;
  return { x: edge, width: bare, title: null, titleWidth: 0 };
}

/** The text cut to a width, with an ellipsis when it had to be cut. */
function shorten(text: string, width: number, font: string): string {
  if (measure(text, font) <= width) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, middle).trimEnd()}…`, font) <= width)
      low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

function Avatar(props: {
  readonly avatar: TimeLanesItem["avatar"];
  readonly x: number;
  readonly mid: number;
}): React.ReactNode {
  const { avatar, x, mid } = props;
  if (avatar.letter === null)
    return (
      <g className="time-lanes-avatar" data-tone={avatar.tone}>
        <circle cx={x + AVATAR / 2} cy={mid} r={AVATAR / 2} />
        <UserRound
          x={x + 4}
          y={mid - 6}
          width={12}
          height={12}
          aria-hidden="true"
        />
      </g>
    );
  return (
    <g className="time-lanes-avatar" data-tone={avatar.tone}>
      <rect x={x} y={mid - AVATAR / 2} width={AVATAR} height={AVATAR} rx={6} />
      <text x={x + AVATAR / 2} y={mid + 3.5} textAnchor="middle">
        {avatar.letter}
      </text>
    </g>
  );
}

/** The details of one item, beside it. */
function Card(props: {
  readonly entry: Placed;
  readonly geometry: Geometry;
  readonly byId: ReadonlyMap<string, Placed>;
  readonly now: number | null;
  readonly bounds: TimeRange;
  readonly linkWords: NonNullable<TimeLanesProps["linkWords"]>;
  readonly onKeep: () => void;
  readonly onLeave: () => void;
  readonly onBottom: (bottom: number) => void;
}): React.ReactNode {
  const { entry, geometry, byId, onBottom } = props;
  const { item } = entry;
  const card = React.useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    setHeight(card.current?.offsetHeight ?? 0);
  }, [entry]);
  // Left of the item and its label when the timeline has room there, else
  // under the item. The card never covers the item it describes.
  const start = Math.min(entry.x0, entry.labelX);
  const beside = start - 14 - CARD_WIDTH >= LEFT;
  const left = beside
    ? start - 14 - CARD_WIDTH
    : Math.min(Math.max(start, 8), geometry.width - CARD_WIDTH - 8);
  const top = beside
    ? Math.max(8, Math.min(entry.mid - 24, geometry.height - height - 8))
    : entry.mid + LANE / 2 + 4;
  React.useLayoutEffect(() => {
    onBottom(top + height + 8);
  }, [onBottom, top, height]);
  const parent = item.parent === null ? undefined : byId.get(item.parent);
  const children = [...byId.values()].filter(
    (other) => other.item.parent === item.id,
  );
  return (
    <div
      ref={card}
      className="time-lanes-card"
      role="dialog"
      aria-label={item.title}
      style={{ left, top }}
      onMouseEnter={props.onKeep}
      onMouseLeave={props.onLeave}
    >
      <p className="time-lanes-card-meta">{item.card.meta}</p>
      <h4 className={item.untitled ? "is-untitled" : undefined}>
        {item.title}
      </h4>
      <ol
        className="time-lanes-card-steps"
        data-dated={
          props.bounds[1] - props.bounds[0] > ONE_DAY_LIMIT ? "" : undefined
        }
      >
        {item.card.steps.map((step) => (
          <li key={`${step.text}-${String(step.at)}`} data-tone={step.tone}>
            <time>
              {step.label ??
                (step.at === null ? "now" : timeIn(props.bounds, step.at))}
            </time>
            <i aria-hidden="true" />
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
      {item.card.note === null ? null : (
        <p className="time-lanes-card-note">{item.card.note}</p>
      )}
      {parent !== undefined || children.length > 0 ? (
        <div className="time-lanes-card-links">
          {parent === undefined ? null : (
            <p>
              {props.linkWords.parent} <b>{parent.item.title}</b>
            </p>
          )}
          {children.map((child) => (
            <p key={child.item.id}>
              {props.linkWords.child} <b>{child.item.title}</b>
            </p>
          ))}
        </div>
      ) : null}
      {item.card.action === null ? null : (
        <div className="time-lanes-card-actions">
          <button type="button" onClick={item.card.action.run}>
            {item.card.action.label}
          </button>
        </div>
      )}
    </div>
  );
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
