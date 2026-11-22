import type { OrganisationAdmissionAction } from "@purin-labs/tenancy/organisation-access/access";
import {
  authorizeOrganisationControl,
  resolveControlSessionById,
  type ActiveOrganisationMembership,
  type ControlRole,
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * The membership behind a socket's control session, read again now. A check
 * that could not run is `unavailable`, not a refusal: the account check or a
 * read failed, and a later check can pass.
 */
type SocketSessionAccess =
  | Readonly<{ kind: "member"; membership: ActiveOrganisationMembership }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

type SocketSessionCheck = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  controlSessionId: ControlSessionId;
  userId: UserId;
  action: OrganisationAdmissionAction;
  requiredRole: ControlRole;
}>;

/**
 * `refused` when the session ended, belongs to another user, or no longer
 * holds `requiredRole` for `action` in the scope's Organisation.
 */
export async function socketSessionAccess(
  input: SocketSessionCheck,
): Promise<SocketSessionAccess> {
  try {
    const session = await resolveControlSessionById({
      db: input.env.DB,
      controlSessionId: input.controlSessionId,
      now: Date.now(),
    });
    if (!session.ok || session.value.userId !== input.userId)
      return { kind: "refused" };
    const allowed = await authorizeOrganisationControl({
      db: input.scope.database,
      accountAccess: input.scope.accountAccess,
      action: input.action,
      session: session.value,
      organisationId: input.scope.organisationId,
      requiredRole: input.requiredRole,
    });
    if (allowed.ok)
      return { kind: "member", membership: allowed.value.membership };
    return allowed.error.code === "authority_unavailable"
      ? { kind: "unavailable" }
      : { kind: "refused" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The membership, or `null` when the check refused it or could not run. */
export async function socketSessionMembership(
  input: SocketSessionCheck,
): Promise<ActiveOrganisationMembership | null> {
  const access = await socketSessionAccess(input);
  return access.kind === "member" ? access.membership : null;
}
