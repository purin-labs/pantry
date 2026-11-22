import type { HarnessTurnLease } from "@purin-labs/contracts";

import type {
  GlobalDatabase,
  OrganisationDatabase,
} from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationAccess } from "@purin-labs/tenancy/organisation-access/access";
import { definePort } from "@purin-labs/kernel/port";

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

const sessionTurnAccess = definePort<SessionTurnAccessCheck>(
  "session_turn_access",
);

/**
 * The Session Durable Object class registers the rule when its module
 * loads, before the Session runs a turn.
 */
export const registerSessionTurnAccess = sessionTurnAccess.register;

/** Checks a turn of the Session with the registered rule. */
export function authorizeSessionTurnLease(
  ...input: Parameters<SessionTurnAccessCheck>
): Promise<boolean> {
  return sessionTurnAccess.use()(...input);
}
