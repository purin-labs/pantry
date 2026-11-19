import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../env";
import type { SessionExecutionAdmission } from "../actors/session-execution-admission";

/**
 * The authority that a session tool handler receives for one turn. The
 * Session builds it once, after the turn's admission, its lease and its Case
 * assignment are known; a handler cannot reach another turn's authority.
 */
export interface SessionToolContext {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly execution: SessionExecutionAdmission;
  readonly lease: HarnessTurnLease;
  readonly assignment: CaseAssignment;
}

/**
 * Returns a function that gives one handler this turn's context, so that the
 * tool authority names each handler once instead of repeating its arguments.
 */
export function withToolContext(context: SessionToolContext) {
  return <Args extends readonly unknown[], Result>(
      handler: (context: SessionToolContext, ...args: Args) => Result,
    ) =>
    (...args: Args): Result =>
      handler(context, ...args);
}
