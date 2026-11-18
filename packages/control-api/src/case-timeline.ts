import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@seams/std";

import {
  isCaseExecutionAssignmentRole,
  isCaseExecutionAssignmentState,
  type CaseExecutionAssignmentState,
} from "./case-execution";

/**
 * One Case as an event on the day's timeline: its title, who held it and
 * when, the context it used and what came of it. Each part is a summary of
 * the Case's execution projection as one reader may see it, so a record
 * withheld from that reader adds to `withheld` and to nothing else.
 */
export type CaseTimelineOutcomeKind =
  /** A person has not decided an approval yet. */
  | "waiting"
  | "approved"
  | "rejected"
  /** A governed effect was confirmed with a provider receipt. */
  | "receipt"
  /** A reply reached its destination. */
  | "delivered"
  | "failed"
  /** The agent's work has not settled. */
  | "running"
  /** The agent finished, and no approval, effect or delivery is recorded. */
  | "done";

/**
 * A stretch of time in which an agent worked on the Case, or a person had
 * to decide. `to` is null while it lasts.
 */
export type CaseTimelineSpan = Readonly<{
  holder: "agent" | "person";
  from: number;
  to: number | null;
}>;

export type CaseTimelineCase = Readonly<{
  caseId: string;
  /** The Case origin kind, as the Case list carries it. */
  origin: string;
  /**
   * The title this reader may see: a side Case's title when the reader may
   * receive the turn that proposed it, else the title of a chat the reader
   * can open, else the title an open trigger or commerce proposal of the
   * Case shows. Null when none applies.
   */
  title: string | null;
  /** The earliest time any visible record of the Case carries. */
  startedAt: number;
  source: Readonly<{ at: number; trigger: TimelineTrigger | null }>;
  agent: Readonly<{
    at: number;
    role: "coordinator" | "research" | "specialist";
    state: CaseExecutionAssignmentState;
  }> | null;
  context: Readonly<{
    at: number;
    /** Memory revisions the visible turns were given. */
    memories: number;
    /** Tool calls with read authority. */
    reads: number;
  }> | null;
  /** Who held the Case and when, in time order. */
  spans: readonly CaseTimelineSpan[];
  outcome: Readonly<{ kind: CaseTimelineOutcomeKind; at: number }> | null;
  /** True when a governed effect of the Case holds a provider receipt. */
  receipt: boolean;
  /** Records of the Case that this reader may not see. */
  withheld: number;
  /**
   * The Case that proposed this one as a side Case, when the reader may
   * receive the proposing turn and may know of that Case.
   */
  sideCaseOf: string | null;
}>;

export type CaseTimelineDay = Readonly<{
  from: number;
  to: number;
  cases: readonly CaseTimelineCase[];
  /** True when more Cases fell in the window than one read carries. */
  truncated: boolean;
}>;

/**
 * One run of an agent's schedule: the window it ran for and the Case it
 * opened, as this reader may see that Case on the timeline.
 */
export type ScheduleRun = Readonly<{
  bindingId: string;
  installationId: string;
  /** The schedule window, as the dispatcher keys it. */
  windowKey: string;
  dispatchedAt: number;
  case: CaseTimelineCase;
}>;

export type ScheduleRunsDay = Readonly<{
  from: number;
  to: number;
  runs: readonly ScheduleRun[];
  /** Runs in the window whose Case this reader may not read. */
  withheld: number;
  /** True when more runs fell in the window than one read carries. */
  truncated: boolean;
}>;

/** The longest window one read covers. */
export const MAX_CASE_TIMELINE_WINDOW = 32 * 86_400_000;
/** The most spans one Case carries. */
export const MAX_CASE_TIMELINE_SPANS = 32;

const OUTCOMES: Record<CaseTimelineOutcomeKind, true> = {
  waiting: true,
  approved: true,
  rejected: true,
  receipt: true,
  delivered: true,
  failed: true,
  running: true,
  done: true,
};
type TimelineTrigger = "connector" | "cue" | "api";
const TRIGGERS: Record<TimelineTrigger, true> = {
  connector: true,
  cue: true,
  api: true,
};
const HOLDERS: Record<CaseTimelineSpan["holder"], true> = {
  agent: true,
  person: true,
};

function isSpanHolder(raw: unknown): raw is CaseTimelineSpan["holder"] {
  return typeof raw === "string" && Object.hasOwn(HOLDERS, raw);
}

function isTimelineTrigger(raw: unknown): raw is TimelineTrigger {
  return typeof raw === "string" && Object.hasOwn(TRIGGERS, raw);
}

export function isCaseTimelineOutcomeKind(
  raw: unknown,
): raw is CaseTimelineOutcomeKind {
  return typeof raw === "string" && Object.hasOwn(OUTCOMES, raw);
}

export function parseCaseTimelineDay(raw: unknown): CaseTimelineDay | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["from", "to", "cases", "truncated"]) ||
    !isNonNegativeInteger(raw.from) ||
    !isNonNegativeInteger(raw.to) ||
    raw.to <= raw.from ||
    typeof raw.truncated !== "boolean" ||
    !Array.isArray(raw.cases)
  )
    return null;
  const cases: CaseTimelineCase[] = [];
  for (const item of raw.cases) {
    const parsed = parseCase(item);
    if (parsed === null) return null;
    cases.push(parsed);
  }
  return { from: raw.from, to: raw.to, cases, truncated: raw.truncated };
}

function parseCase(raw: unknown): CaseTimelineCase | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "caseId",
      "origin",
      "title",
      "startedAt",
      "source",
      "agent",
      "context",
      "spans",
      "outcome",
      "receipt",
      "withheld",
      "sideCaseOf",
    ]) ||
    typeof raw.caseId !== "string" ||
    raw.caseId.length === 0 ||
    typeof raw.origin !== "string" ||
    !(raw.title === null || typeof raw.title === "string") ||
    !isNonNegativeInteger(raw.startedAt) ||
    typeof raw.receipt !== "boolean" ||
    !isNonNegativeInteger(raw.withheld) ||
    !(
      raw.sideCaseOf === null ||
      (typeof raw.sideCaseOf === "string" && raw.sideCaseOf.length > 0)
    ) ||
    !Array.isArray(raw.spans) ||
    raw.spans.length > MAX_CASE_TIMELINE_SPANS
  )
    return null;
  const source = raw.source;
  if (
    !isRecord(source) ||
    !hasExactKeys(source, ["at", "trigger"]) ||
    !isNonNegativeInteger(source.at) ||
    !(source.trigger === null || isTimelineTrigger(source.trigger))
  )
    return null;
  let agent: CaseTimelineCase["agent"] = null;
  if (raw.agent !== null) {
    const value = raw.agent;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["at", "role", "state"]) ||
      !isNonNegativeInteger(value.at) ||
      !isCaseExecutionAssignmentRole(value.role) ||
      !isCaseExecutionAssignmentState(value.state)
    )
      return null;
    agent = { at: value.at, role: value.role, state: value.state };
  }
  let context: CaseTimelineCase["context"] = null;
  if (raw.context !== null) {
    const value = raw.context;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["at", "memories", "reads"]) ||
      !isNonNegativeInteger(value.at) ||
      !isNonNegativeInteger(value.memories) ||
      !isNonNegativeInteger(value.reads) ||
      !isPositiveInteger(value.memories + value.reads)
    )
      return null;
    context = { at: value.at, memories: value.memories, reads: value.reads };
  }
  const spans: CaseTimelineSpan[] = [];
  for (const value of raw.spans) {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["holder", "from", "to"]) ||
      !isSpanHolder(value.holder) ||
      !isNonNegativeInteger(value.from) ||
      !(
        value.to === null ||
        (isNonNegativeInteger(value.to) && value.to >= value.from)
      )
    )
      return null;
    spans.push({ holder: value.holder, from: value.from, to: value.to });
  }
  let outcome: CaseTimelineCase["outcome"] = null;
  if (raw.outcome !== null) {
    const value = raw.outcome;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["kind", "at"]) ||
      !isCaseTimelineOutcomeKind(value.kind) ||
      !isNonNegativeInteger(value.at)
    )
      return null;
    outcome = { kind: value.kind, at: value.at };
  }
  return {
    caseId: raw.caseId,
    origin: raw.origin,
    title: raw.title,
    startedAt: raw.startedAt,
    source: { at: source.at, trigger: source.trigger },
    agent,
    context,
    spans,
    outcome,
    receipt: raw.receipt,
    withheld: raw.withheld,
    sideCaseOf: raw.sideCaseOf,
  };
}

export function parseScheduleRunsDay(raw: unknown): ScheduleRunsDay | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["from", "to", "runs", "withheld", "truncated"]) ||
    !isNonNegativeInteger(raw.from) ||
    !isNonNegativeInteger(raw.to) ||
    raw.to <= raw.from ||
    !isNonNegativeInteger(raw.withheld) ||
    typeof raw.truncated !== "boolean" ||
    !Array.isArray(raw.runs)
  )
    return null;
  const runs: ScheduleRun[] = [];
  for (const item of raw.runs) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        "bindingId",
        "installationId",
        "windowKey",
        "dispatchedAt",
        "case",
      ]) ||
      typeof item.bindingId !== "string" ||
      item.bindingId.length === 0 ||
      typeof item.installationId !== "string" ||
      item.installationId.length === 0 ||
      typeof item.windowKey !== "string" ||
      item.windowKey.length === 0 ||
      !isNonNegativeInteger(item.dispatchedAt)
    )
      return null;
    const event = parseCase(item.case);
    if (event === null) return null;
    runs.push({
      bindingId: item.bindingId,
      installationId: item.installationId,
      windowKey: item.windowKey,
      dispatchedAt: item.dispatchedAt,
      case: event,
    });
  }
  return {
    from: raw.from,
    to: raw.to,
    runs,
    withheld: raw.withheld,
    truncated: raw.truncated,
  };
}
