// Refactor 16 step 7: what a journey asserts about the margins of a robot
// operation against the robot's rated limits. The engine measures them and
// reports them in each terminal outcome after the first step; the TypeBox
// contract of the Portal checks their shape here too.
import assert from "node:assert/strict";
import {
  parseOperationMargins,
  summarizeMargins,
} from "../../packages/bakery-model/src/bakery-margins.ts";

const TERMINAL = new Set([
  "completed",
  "failed",
  "recovered",
  "execution-error",
]);

/** Every terminal outcome in an engine output, in document order. */
export function outcomesIn(value, found = []) {
  if (Array.isArray(value)) for (const item of value) outcomesIn(item, found);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        key === "outcome" &&
        item !== null &&
        typeof item === "object" &&
        TERMINAL.has(item.kind) &&
        Number.isInteger(item.step)
      )
        found.push(item);
      else outcomesIn(item, found);
    }
  }
  return found;
}

/**
 * The margins of an operation that moved: each rated joint stayed below its
 * rated speed (a margin above zero), no joint passed it, and the warnings
 * are exactly `warnings` (kinds, in any order). Returns the summary numbers
 * for the journey's report.
 */
export function assertMargins(outcome, warnings = [], label = "operation") {
  assert.notEqual(
    outcome.kind,
    "execution-error",
    `${label}: ${outcome.message}`,
  );
  assert.ok(outcome.margins, `${label}: an operation that moved has margins`);
  const margins = parseOperationMargins(outcome.margins);
  assert.equal(
    margins.overspeed,
    null,
    `${label}: no joint passed its rated speed`,
  );
  for (const joint of margins.joints)
    if (joint.ratedSpeed.kind === "rated")
      assert.ok(
        joint.peakSpeedRadS < joint.ratedSpeed.value,
        `${label}: ${joint.joint} peak ${joint.peakSpeedRadS} rad/s is below its rating ${joint.ratedSpeed.value}`,
      );
  assert.deepEqual(
    margins.warnings.map((warning) => warning.kind).sort(),
    [...warnings].sort(),
    `${label}: warnings ${JSON.stringify(margins.warnings)}`,
  );
  const summary = summarizeMargins(margins);
  assert.equal(summary.kind, "measured");
  return {
    tightestJoint: summary.tightestJoint.joint,
    tightestShare:
      summary.tightestJoint.ratedSpeedRadS === null
        ? null
        : summary.tightestJoint.peakSpeedRadS /
          summary.tightestJoint.ratedSpeedRadS,
    longestClampSeconds: summary.longestClamp.seconds,
    peakPenetrationMm: margins.peakPenetrationM * 1000,
    deepestContact: margins.deepestContact,
    peakSlipMm: margins.peakSlipM * 1000,
    warnings: margins.warnings.map((warning) => warning.kind),
  };
}

/** An accepted operation: completed (or recovered), with its margins. */
export function assertAcceptedMargins(
  outcome,
  warnings = [],
  label = "operation",
) {
  assert.ok(
    outcome.kind === "completed" || outcome.kind === "recovered",
    `${label}: accepted, not ${outcome.kind} ${outcome.reason ?? ""}`,
  );
  return assertMargins(outcome, warnings, label);
}

/** A plan that failed before its first step measured nothing. */
export function assertNotMeasured(outcome, label = "operation") {
  assert.equal(outcome.step, 0, `${label}: failed before its first step`);
  assert.equal(
    outcome.margins,
    undefined,
    `${label}: no margins before a step`,
  );
}
