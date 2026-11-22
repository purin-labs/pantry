import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { MachineCensus } from "../lifecycle/machine-census";
import { ASSIGNMENT_ABANDON_AFTER_MS } from "./assignment.machine";
import { activeAssignmentTimes } from "./lifecycle";

/** True when the Case holds an active assignment old enough to abandon. */
export function hasStaleAssignment(sql: SqlStorage, now: number): boolean {
  return activeAssignmentTimes(sql).some(
    (since) => since + ASSIGNMENT_ABANDON_AFTER_MS <= now,
  );
}

/**
 * Logs why a Case with an old active assignment did not try to end it, so
 * each stale assignment that stays names its cause (Refactor 15). Codes and
 * ids only, never content.
 */
export function logAbandonSkipped(
  fields: Readonly<{
    reason: string;
    case_id?: string;
    assignment_id?: string;
  }>,
): void {
  traceWarn("case.assignment_abandon_skipped", {
    requestId: newRequestId(),
    ...fields,
  });
}

/**
 * The census of this Case's active assignments that are old enough to
 * abandon, keyed by the Case lifecycle kind and by whether the Case has an
 * alarm (for example `open:alarm`). An old assignment in an open Case with an
 * alarm waits for its Session to prove that it runs no turn; one in a Case
 * that is not open waits for the Case. Counts only, never content. Null when
 * the Case holds no old active assignment.
 */
export function staleAssignmentCensus(
  sql: SqlStorage,
  alarm: number | null,
  now: number,
): MachineCensus | null {
  const stale = activeAssignmentTimes(sql).filter(
    (since) => since + ASSIGNMENT_ABANDON_AFTER_MS <= now,
  ).length;
  if (stale === 0) return null;
  const meta = sql
    .exec<{ kind: string | null }>(
      "SELECT json_extract(lifecycle_json, '$.kind') AS kind FROM case_meta WHERE singleton = 1",
    )
    .toArray()[0];
  const caseKind = meta?.kind ?? "no_meta";
  return {
    machine: "case_assignment_stale",
    states: { [`${caseKind}:${alarm === null ? "no_alarm" : "alarm"}`]: stale },
  };
}
