// The trial Organisation's owner and the access helpers of the trial
// Workers. Pantry keeps its own members (Plan 95), so the trial needs no
// outside account authority.
import { acceptedExecutionAuthority } from "../../foundation/tenancy/organisation-access/access.ts";
import { compileTurnAuthority } from "../../foundation/authority/authorization/access-grants/turn-authority.ts";
import { parseUserId } from "../../packages/control-api/src/ids.ts";
import { OrganisationExecutionScope } from "../../foundation/tenancy/organisation-execution-scope.ts";

// The trial Organisation has one Pantry owner. The trial people keep their
// operator roles, so a trial can demote or revoke them. It lives here, not in
// a trial's entry module, which may export only handlers.
const parsedOwnerUser = parseUserId(
  "user_00000000-0000-5000-8000-000000000050",
);
if (!parsedOwnerUser.ok) throw new Error("Invalid trial owner");
export const ownerUser = parsedOwnerUser.value;

/** The account access of the trial Organisation's current placement. */
export async function trialAccountAccess(env, organisationId) {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value.accountAccess;
}

/** The turn authority of an accepted turn, under the current account check. */
export async function compileTrialTurnAuthority(env, input) {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!scope.ok) return { ok: false, error: scope.error };
  return compileTurnAuthority({
    db: scope.value.database,
    accountAccess: scope.value.accountAccess,
    userAuthority: acceptedExecutionAuthority(input.sessionId, input.turnId),
    action: "execute",
    organisationId: input.organisationId,
    requestAuthority: input.requestAuthority,
    policy: input.policy,
  });
}
