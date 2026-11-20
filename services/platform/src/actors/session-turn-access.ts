import type { HarnessTurnLease } from "@purin-labs/contracts";

import type { GlobalDatabase, OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import type { OrganisationAccess } from "../organisation-access/access";

/**
 * Whether the person of a Session turn may still use it: the live authority
 * of the turn, and the access of its origin to its conversation and Project.
 * The conversation module owns the rule (`chat/turn-access.ts`).
 */
export type SessionTurnAccessCheck = (
  globalDatabase: GlobalDatabase,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  accountAccess: OrganisationAccess,
) => Promise<boolean>;

let registered: SessionTurnAccessCheck | null = null;

/**
 * The Session Durable Object class registers the rule when its module
 * loads, before the Session runs a turn.
 */
export function registerSessionTurnAccess(check: SessionTurnAccessCheck): void {
  registered = check;
}

/** Checks a turn of the Session with the registered rule. */
export function authorizeSessionTurnLease(
  ...input: Parameters<SessionTurnAccessCheck>
): Promise<boolean> {
  if (registered === null) throw new Error("session_turn_access_unregistered");
  return registered(...input);
}
