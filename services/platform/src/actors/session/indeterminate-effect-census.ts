import type { MachineCensus } from "../lifecycle/machine-census";

const DAY_MS = 24 * 60 * 60_000;
/** A kind or a reason is a code, never free text. Anything else is `other`. */
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * The census of this Session's outbox effects whose result nobody knows,
 * keyed by the request kind of the effect, the reason that made it
 * indeterminate and the age of that state (for example
 * `code_mode_execution.v1:process_lost:ge_7d`). Each one keeps the Session
 * quarantined. Counts only, never content or ids. Null when the Session holds
 * no indeterminate effect.
 */
export function indeterminateEffectCensus(
  sql: SqlStorage,
  now: number,
): MachineCensus | null {
  const rows = sql
    .exec<{
      kind: SqlStorageValue;
      reason: SqlStorageValue;
      updated_at: number;
    }>(
      `SELECT json_extract(request_envelope, '$.kind') AS kind,
         json_extract(state_projection, '$.reason') AS reason, updated_at
       FROM actor_outbox WHERE state_kind = 'indeterminate'`,
    )
    .toArray();
  if (rows.length === 0) return null;
  const states: Record<string, number> = {};
  for (const row of rows) {
    const key = `${code(row.kind, "no_kind")}:${code(row.reason, "no_reason")}:${ageBucket(now - row.updated_at)}`;
    states[key] = (states[key] ?? 0) + 1;
  }
  return { machine: "session_indeterminate_effect", states };
}

function code(value: SqlStorageValue, missing: string): string {
  if (value === null) return missing;
  return typeof value === "string" && CODE.test(value) ? value : "other";
}

function ageBucket(age: number): "lt_1d" | "lt_7d" | "ge_7d" {
  if (age < DAY_MS) return "lt_1d";
  return age < 7 * DAY_MS ? "lt_7d" : "ge_7d";
}
