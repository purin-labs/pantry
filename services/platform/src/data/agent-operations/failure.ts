import type { D1Database } from "@cloudflare/workers-types";
import type { AgentOperationsError } from "../agent-operations";

/**
 * Commits an operation's writes together with whatever must land with them.
 *
 * The trailing statements are the caller's evidence that this operation ran —
 * an idempotency receipt, a draft settlement. They have to commit in the same
 * batch as the effect: if the effect lands and the evidence does not, a retry
 * re-runs the effect, which either increments a revision twice or reports a
 * conflict for a change that actually succeeded.
 */
export async function commitWithTrailing(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await db.batch([...statements, ...trailing]);
}

export function fail(message: string): never {
  throw new Error(`agent_operations_${message}`);
}

export function failUnhandled(value: never): never {
  return fail(`unhandled_${String(value)}`);
}

export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /constraint|unique|foreign key/i.test(error.message)
  );
}

export class AgentOperationFailure extends Error {
  constructor(readonly value: AgentOperationsError) {
    super(value.code);
  }
}
