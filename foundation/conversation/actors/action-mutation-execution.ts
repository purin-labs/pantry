import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { definePort } from "@purin-labs/kernel/port";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import { parseOrganisationPlacementFenceToken } from "@purin-labs/tenancy/data/organisation-placement";
import {
  parseOrganisationId,
  parseControlSessionId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
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
} from "@purin-labs/tenancy/data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
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

export type SlackLinkedMember = Readonly<{
  userId: UserId;
  personId: string;
  role: "owner" | "admin" | "operator" | "viewer";
}>;

/**
 * The verified links between a Slack user and a Pantry user that the
 * conversation module reads (Refactor 17). Each member is one D1 read. The
 * Slack surface owns the links, and the Worker registers its reads
 * (`worker-ports.ts`).
 */
export type SlackIdentityLinks = Readonly<{
  /**
   * The member behind a Slack user, right now: a verified link to their
   * Pantry user in the Slack workspace of an active Slack account, and an
   * active membership. Null when there is none.
   */
  resolveLinkedMember(
    db: OrganisationDatabase,
    input: Readonly<{
      organisationId: string;
      integrationAccountId: string;
      workspaceId: string;
      slackUserId: string;
    }>,
  ): Promise<SlackLinkedMember | null>;
  /** The Slack user ids that a Pantry user has a link to. */
  linkedSlackUserIds(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    userId: UserId,
  ): Promise<readonly string[]>;
}>;

export const slackIdentityLinks = definePort<SlackIdentityLinks>(
  "slack_identity_links",
);

/**
 * The member behind a Slack user, right now: a verified link to their Pantry
 * user in the Slack workspace of an active Slack account, and an active
 * membership. Null when there is none. Each caller checks the role that its
 * action needs. The Slack surface reads the link.
 */
export function resolveSlackLinkedMember(
  db: OrganisationDatabase,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    workspaceId: string;
    slackUserId: string;
  }>,
): Promise<SlackLinkedMember | null> {
  return slackIdentityLinks.use().resolveLinkedMember(db, input);
}

/**
 * Whether a Slack user is, right now, an owner or admin of the Organisation
 * through a verified link to their Pantry user. Null when not; otherwise the
 * person and role.
 */
export async function resolveSlackApprover(
  db: OrganisationDatabase,
  input: Parameters<typeof resolveSlackLinkedMember>[1],
): Promise<Readonly<{
  userId: UserId;
  personId: string;
  role: "owner" | "admin";
}> | null> {
  const member = await resolveSlackLinkedMember(db, input);
  return member === null || (member.role !== "owner" && member.role !== "admin")
    ? null
    : { userId: member.userId, personId: member.personId, role: member.role };
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
