import type { OrganisationDatabase } from "../database-handles";
import { parseOrganisationPlacement } from "../placement";
import { parseOrganisationPlacementFenceToken } from "../data/organisation-placement";
import {
  parseOrganisationId,
  parseControlSessionId,
  parseUserId,
} from "../ids";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  assertNever,
  hasExactKeys,
  isRecord,
  isNonNegativeInteger,
} from "@purin-labs/std";
import {
  authorizeSessionTurnExecution,
  parseSessionTurnExecution,
  sessionTurnExecution,
  type SessionTurnExecution,
} from "../chat/turn-access";
import {
  authorizeOrganisationControl,
  resolveControlSessionById,
  type ActiveControlSession,
} from "../data/control-plane";
import type { Env } from "../env";
import type { ControlSessionId, OrganisationId, UserId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Variant } from "@purin-labs/type-utils";

type CapturedActionPlacement = Readonly<{
  organisationId: OrganisationId;
  placement: OrganisationExecutionScope["placement"];
  fenceToken: OrganisationExecutionScope["fenceToken"];
  deadlineAt: number;
}>;

export type ActionMutationExecution = CapturedActionPlacement &
  (
    | Readonly<{
        kind: "session_turn";
        execution: SessionTurnExecution;
        controlSessionId?: never;
        userId?: never;
      }>
    | Readonly<{
        kind: "control_session";
        controlSessionId: ControlSessionId;
        userId: UserId;
        execution?: never;
      }>
    | Readonly<{
        /** An owner or admin who approves from a Slack card. */
        kind: "slack_approver";
        userId: UserId;
        integrationAccountId: string;
        workspaceId: string;
        slackUserId: string;
        execution?: never;
        controlSessionId?: never;
      }>
  );

/**
 * Whether a Slack user is, right now, an owner or admin of the Organisation
 * through a verified link to their Pantry user, in the Slack workspace of an
 * active Slack account. Null when not; otherwise the person and role.
 */
export async function resolveSlackApprover(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    workspaceId: string;
    slackUserId: string;
  }>,
): Promise<Readonly<{
  userId: UserId;
  personId: string;
  role: "owner" | "admin";
}> | null> {
  const row = await db
    .prepare(
      `SELECT identity_link.user_id AS userId, membership.person_id AS personId,
              membership.role AS role
       FROM integration_account AS account
       JOIN external_identity_link AS identity_link
         ON identity_link.organisation_id = account.organisation_id
        AND identity_link.workspace_connection_id = account.provider_connection_id
        AND identity_link.workspace_id = ? AND identity_link.external_user_id = ?
       JOIN service_role_grant AS membership
         ON membership.organisation_id = identity_link.organisation_id
        AND membership.user_id = identity_link.user_id AND membership.status = 'active'
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND account.provider = 'slack' AND account.lifecycle = 'active'`,
    )
    .bind(
      input.workspaceId,
      input.slackUserId,
      input.organisationId,
      input.integrationAccountId,
    )
    .first<{
      readonly userId: unknown;
      readonly personId: unknown;
      readonly role: unknown;
    }>();
  if (
    row === null ||
    typeof row.personId !== "string" ||
    typeof row.userId !== "string"
  )
    return null;
  const userId = parseUserId(row.userId);
  if (!userId.ok || (row.role !== "owner" && row.role !== "admin")) return null;
  return { userId: userId.value, personId: row.personId, role: row.role };
}

export function sessionActionMutationExecution(
  scope: OrganisationExecutionScope,
  lease: HarnessTurnLease,
): Variant<ActionMutationExecution, "session_turn"> {
  return {
    kind: "session_turn",
    execution: sessionTurnExecution(lease),
    organisationId: scope.organisationId,
    placement: scope.placement,
    fenceToken: scope.fenceToken,
    deadlineAt: lease.expiresAt,
  };
}

export async function controlActionMutationExecution(
  env: Env,
  organisationId: OrganisationId,
  session: ActiveControlSession,
) {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) return scope;
  const execution: ActionMutationExecution = {
    kind: "control_session",
    controlSessionId: session.controlSessionId,
    userId: session.userId,
    organisationId,
    placement: scope.value.placement,
    fenceToken: scope.value.fenceToken,
    deadlineAt: session.expiresAt,
  };
  return { ok: true as const, value: execution };
}

export async function authorizeActionMutationExecution(
  env: Env,
  scope: OrganisationExecutionScope,
  execution: ActionMutationExecution,
): Promise<boolean> {
  if (
    execution.organisationId !== scope.organisationId ||
    execution.deadlineAt <= Date.now() ||
    execution.fenceToken !== scope.fenceToken ||
    execution.placement.placementEpoch !== scope.placement.placementEpoch ||
    execution.placement.placementCellId !== scope.placement.placementCellId ||
    !(await scope.isActive())
  )
    return false;
  let allowed: boolean;
  switch (execution.kind) {
    case "session_turn":
      allowed = await authorizeSessionTurnExecution(
        env.DB,
        scope.database,
        scope.organisationId,
        execution.execution,
        scope.accountAccess,
      );
      break;
    case "control_session": {
      const session = await resolveControlSessionById({
        db: env.DB,
        controlSessionId: execution.controlSessionId,
        now: Date.now(),
      });
      if (!session.ok || session.value.userId !== execution.userId)
        return false;
      const authority = await authorizeOrganisationControl({
        db: scope.database,
        accountAccess: scope.accountAccess,
        action: "execute",
        session: session.value,
        organisationId: scope.organisationId,
        requiredRole: "operator",
      });
      allowed = authority.ok;
      break;
    }
    case "slack_approver": {
      const approver = await resolveSlackApprover(scope.database, {
        organisationId: scope.organisationId,
        integrationAccountId: execution.integrationAccountId,
        workspaceId: execution.workspaceId,
        slackUserId: execution.slackUserId,
      });
      allowed = approver !== null && approver.userId === execution.userId;
      break;
    }
    default:
      return assertNever(execution);
  }
  return (
    allowed && execution.deadlineAt > Date.now() && (await scope.isActive())
  );
}

export function parseActionMutationExecution(
  raw: unknown,
): ActionMutationExecution | null {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    !isNonNegativeInteger(raw.deadlineAt)
  )
    return null;
  const organisationId = parseOrganisationId(raw.organisationId);
  const placement = parseOrganisationPlacement(raw.placement);
  const fenceToken = parseOrganisationPlacementFenceToken(raw.fenceToken);
  if (!organisationId.ok || !placement.ok || !fenceToken.ok) return null;
  switch (raw.kind) {
    case "session_turn": {
      if (
        !hasExactKeys(raw, [
          "kind",
          "organisationId",
          "placement",
          "fenceToken",
          "deadlineAt",
          "execution",
        ])
      )
        return null;
      const execution = parseSessionTurnExecution(raw.execution);
      if (
        execution === null ||
        execution.requestAuthority.organisationId !== organisationId.value
      )
        return null;
      return {
        kind: "session_turn",
        organisationId: organisationId.value,
        placement: placement.value,
        fenceToken: fenceToken.value,
        deadlineAt: raw.deadlineAt,
        execution,
      };
    }
    case "control_session": {
      if (
        !hasExactKeys(raw, [
          "kind",
          "organisationId",
          "placement",
          "fenceToken",
          "deadlineAt",
          "controlSessionId",
          "userId",
        ]) ||
        typeof raw.controlSessionId !== "string" ||
        typeof raw.userId !== "string"
      )
        return null;
      const controlSessionId = parseControlSessionId(raw.controlSessionId);
      const userId = parseUserId(raw.userId);
      if (!controlSessionId.ok || !userId.ok) return null;
      return {
        kind: "control_session",
        organisationId: organisationId.value,
        placement: placement.value,
        fenceToken: fenceToken.value,
        deadlineAt: raw.deadlineAt,
        controlSessionId: controlSessionId.value,
        userId: userId.value,
      };
    }
    case "slack_approver": {
      if (
        !hasExactKeys(raw, [
          "kind",
          "organisationId",
          "placement",
          "fenceToken",
          "deadlineAt",
          "userId",
          "integrationAccountId",
          "workspaceId",
          "slackUserId",
        ]) ||
        typeof raw.userId !== "string" ||
        typeof raw.integrationAccountId !== "string" ||
        typeof raw.workspaceId !== "string" ||
        typeof raw.slackUserId !== "string"
      )
        return null;
      const userId = parseUserId(raw.userId);
      if (!userId.ok) return null;
      return {
        kind: "slack_approver",
        organisationId: organisationId.value,
        placement: placement.value,
        fenceToken: fenceToken.value,
        deadlineAt: raw.deadlineAt,
        userId: userId.value,
        integrationAccountId: raw.integrationAccountId,
        workspaceId: raw.workspaceId,
        slackUserId: raw.slackUserId,
      };
    }
    default:
      return null;
  }
}
