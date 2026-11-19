import {
  isIanaTimezone,
  MAX_EVAL_CRITERIA,
  MAX_EVAL_SCENARIOS,
  type EvalCriterion,
  type EvalReplyOutcome,
  type EvalScenario,
  type EvalSenderChoice,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

/**
 * The scenarios of one Eval while a person edits them. Saving makes a new
 * version to review. Nothing here reads the network.
 */
export type CriterionDraft = Readonly<{
  criterionId: string;
  kind: EvalCriterion["kind"];
  /** The expected result of an `outcome` criterion. */
  expected: EvalReplyOutcome;
  /** The words of a `reply_includes` or `reply_excludes` criterion. */
  text: string;
}>;

export type ScenarioDraft = Readonly<{
  scenarioId: string;
  role: EvalScenario["role"];
  title: string;
  /** The chosen sender, as `senderKey` names it. */
  sender: string;
  subject: string;
  body: string;
  /** The arrival time on a clock in `timezone`, as `YYYY-MM-DDTHH:mm`. */
  arrives: string;
  timezone: string;
  criteria: readonly CriterionDraft[];
}>;

export const EVAL_OUTCOMES: readonly EvalReplyOutcome[] = [
  "approval_required",
  "reply_now",
  "no_reply",
];

export function criterionKindLabel(kind: EvalCriterion["kind"]): string {
  switch (kind) {
    case "outcome":
      return "The agent's decision";
    case "reply_includes":
      return "The reply includes";
    case "reply_excludes":
      return "The reply does not include";
    default:
      return assertNever(kind, "Unexpected value");
  }
}

/** The name of one verification revision in a sender choice. */
export function senderKey(
  sender: Readonly<{ verificationId: string; revision: number }>,
): string {
  return `${sender.verificationId}#${String(sender.revision)}`;
}

function parseSenderKey(
  key: string,
): Readonly<{ verificationId: string; revision: number }> | null {
  const at = key.lastIndexOf("#");
  const revision = Number(key.slice(at + 1));
  return at > 0 && Number.isInteger(revision) && revision > 0
    ? { verificationId: key.slice(0, at), revision }
    : null;
}

function clockParts(epoch: number, zone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  const values: Record<string, number> = {};
  for (const part of parts)
    if (part.type !== "literal") values[part.type] = Number(part.value);
  return values;
}

const two = (value: number | undefined): string =>
  String(value ?? 0).padStart(2, "0");

/** A time as a clock in one zone shows it, for a date and time field. */
function clockInZone(epoch: number, zone: string): string {
  const at = clockParts(epoch, zone);
  return `${String(at.year ?? 1970).padStart(4, "0")}-${two(at.month)}-${two(at.day)}T${two(at.hour)}:${two(at.minute)}`;
}

/**
 * The time at which a clock in one zone shows `clock`, or null when the text
 * is no date and time. A time that a zone skips takes the next valid time.
 */
function epochFromClock(clock: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(clock);
  if (match === null || !isIanaTimezone(zone)) return null;
  const wanted = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  if (Number.isNaN(wanted)) return null;
  // The offset of the zone at the guessed time corrects the guess. A second
  // pass settles a guess that crossed a change of the offset.
  let epoch = wanted;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = clockParts(epoch, zone);
    const shownAt = Date.UTC(
      shown.year ?? 1970,
      (shown.month ?? 1) - 1,
      shown.day ?? 1,
      shown.hour ?? 0,
      shown.minute ?? 0,
    );
    epoch += wanted - shownAt;
  }
  return epoch;
}

function criterionDraft(criterion: EvalCriterion): CriterionDraft {
  return {
    criterionId: criterion.criterionId,
    kind: criterion.kind,
    expected:
      criterion.kind === "outcome" ? criterion.expected : "approval_required",
    text: criterion.kind === "outcome" ? "" : criterion.text,
  };
}

export function scenarioDraft(scenario: EvalScenario): ScenarioDraft {
  return {
    scenarioId: scenario.scenarioId,
    role: scenario.role,
    title: scenario.title,
    sender: senderKey(scenario.sender),
    subject: scenario.message.subject,
    body: scenario.message.body,
    arrives: clockInZone(
      scenario.message.receivedAt,
      scenario.message.timezone,
    ),
    timezone: scenario.message.timezone,
    criteria: scenario.criteria.map(criterionDraft),
  };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function newCriterionDraft(): CriterionDraft {
  return {
    criterionId: newId("criterion"),
    kind: "outcome",
    expected: "approval_required",
    text: "",
  };
}

/**
 * A new scenario that starts from the last one: the same sender and time
 * zone, and a message for the person to write.
 */
export function newScenarioDraft(
  like: ScenarioDraft | undefined,
  senders: readonly EvalSenderChoice[],
  now: number,
): ScenarioDraft {
  const timezone = like?.timezone ?? "UTC";
  const first = senders[0];
  return {
    scenarioId: newId("scenario"),
    role: "control",
    title: "",
    sender: like?.sender ?? (first === undefined ? "" : senderKey(first)),
    subject: "",
    body: "",
    arrives: like?.arrives ?? clockInZone(now, timezone),
    timezone,
    criteria: [newCriterionDraft()],
  };
}

export function canAddScenario(drafts: readonly ScenarioDraft[]): boolean {
  return drafts.length < MAX_EVAL_SCENARIOS;
}

export function canAddCriterion(draft: ScenarioDraft): boolean {
  return draft.criteria.length < MAX_EVAL_CRITERIA;
}

/**
 * The scenarios that the drafts describe, or the first thing that a person
 * must correct. The platform checks the same rules again.
 */
export function scenariosFromDrafts(
  drafts: readonly ScenarioDraft[],
):
  | Readonly<{ ok: true; scenarios: readonly EvalScenario[] }>
  | Readonly<{ ok: false; message: string }> {
  const scenarios: EvalScenario[] = [];
  for (const [index, draft] of drafts.entries()) {
    const name =
      draft.title.trim().length > 0
        ? `"${draft.title.trim()}"`
        : `Scenario ${String(index + 1)}`;
    const sender = parseSenderKey(draft.sender);
    const receivedAt = epochFromClock(draft.arrives, draft.timezone.trim());
    if (draft.title.trim().length === 0)
      return { ok: false, message: `${name} needs a title.` };
    if (sender === null)
      return { ok: false, message: `${name} needs a sender.` };
    if (draft.subject.trim().length === 0 || draft.body.trim().length === 0)
      return {
        ok: false,
        message: `${name} needs a subject and a message.`,
      };
    if (receivedAt === null || receivedAt < 0)
      return {
        ok: false,
        message: `${name} needs a valid time zone, date and time.`,
      };
    const criteria: EvalCriterion[] = [];
    for (const criterion of draft.criteria) {
      if (criterion.kind === "outcome") {
        criteria.push({
          criterionId: criterion.criterionId,
          kind: "outcome",
          expected: criterion.expected,
        });
        continue;
      }
      if (criterion.text.trim().length === 0)
        return {
          ok: false,
          message: `${name} has an expected result with no words.`,
        };
      criteria.push({
        criterionId: criterion.criterionId,
        kind: criterion.kind,
        text: criterion.text.trim(),
      });
    }
    if (criteria.length === 0)
      return { ok: false, message: `${name} needs an expected result.` };
    scenarios.push({
      scenarioId: draft.scenarioId,
      role: draft.role,
      title: draft.title.trim(),
      sender,
      message: {
        subject: draft.subject.trim(),
        body: draft.body.trim(),
        receivedAt,
        timezone: draft.timezone.trim(),
      },
      criteria,
    });
  }
  if (scenarios.length === 0)
    return { ok: false, message: "An eval needs one scenario or more." };
  return { ok: true, scenarios };
}
