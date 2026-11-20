import type { OrganisationDatabase } from "../database-handles";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import { assertNever, canonicalJson, sha256Hex } from "@purin-labs/std";

import { acceptedExecutionAuthority } from "../organisation-access/access";
import type { Env } from "../env";
import { parseConnectorId } from "../ids";
import { validateLiveRequestAuthority } from "../request-authority";
import { resolveActiveConnectorActorAtPlacement } from "./actor-router";
import type {
  HarnessFollowUpRequest,
  HarnessFollowUpResult,
} from "../agent-tools/catalog/types";
import { ExitApprovalRequestedError } from "../agent-tools/errors";
import type {
  HarnessPermissionRequest,
  HarnessPermissionRequestResult,
} from "../agent-tools/catalog/permission";
import {
  consumeHeldEffectPass,
  hasHeldEffectPass,
  insertHeldOutputRequest,
  type HeldEffectPassUse,
  type HeldOutputReason,
} from "../data/held-output-request";
import { heldEffectNoticeText } from "../slack/held-output-notice";
import {
  heldEffectActionRecord,
  type EffectAction,
} from "../agent-tools/effect-action";
import { FlowLabel, joinFlowLabels } from "../policy/information-flow";
import {
  insertAgentPermissionRequest,
  isRequesterRole,
} from "../data/agent-permission-request";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import { isConversationSession } from "../chat/turn-access";
import {
  missingEntityTypeReads,
  type MissingEntityTypeRead,
} from "../authorization/access-grants/entity-type-reads";
import {
  impliedEntityTypeReads,
  readNeedsPrivateChat,
  type RequestableEntityTypeRead,
} from "../authorization/requestable-capabilities";
import { CARD_ONLY_REPLY_INSTRUCTION } from "../slack/card-only-reply";
import { permissionRequestNoticeText } from "../slack/permission-request-notice";
import {
  requireSessionExecution,
  type SessionExecutionAdmission,
} from "./session-execution-admission";
import {
  SLACK_TURN_PREFIX,
  turnMayScheduleFollowUp,
} from "./session/turn-tool-offers";

/**
 * Schedule a new turn in this turn's Slack thread. The thread's Connector
 * queues it as Case work with this turn's requester and authority, due after
 * the delay. The note is not sent anywhere: it stays in this Session's
 * history of the call, under this turn's label, and the follow-up turn reads
 * it there. One call has one stable identity, so a replayed call schedules
 * nothing more.
 */
export async function scheduleFollowUpForHarness(
  input: {
    readonly env: Env;
    readonly execution: SessionExecutionAdmission;
    readonly lease: HarnessTurnLease;
  },
  request: HarnessFollowUpRequest,
): Promise<HarnessFollowUpResult> {
  await requireSessionExecution(input.execution, input.lease);
  const authority = input.lease.requestAuthority;
  const sessionId = String(input.lease.session.sessionId);
  const turnId = String(input.lease.turn.turnId);
  if (
    (authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation") ||
    !turnMayScheduleFollowUp(authority, turnId)
  )
    throw new Error("follow-up authority unavailable");
  const scope = input.execution.scope;
  const live = await validateLiveRequestAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(sessionId, turnId),
    action: "execute",
    authority,
  });
  if (!live.ok) throw new Error("follow-up authority has changed");
  const connectorId = parseConnectorId(String(authority.connectorId));
  if (!connectorId.ok) throw new Error("follow-up Connector identity invalid");
  const followUpId = (
    await sha256Hex(
      canonicalJson({
        sessionId,
        turnId,
        afterMinutes: request.afterMinutes,
        note: request.note,
      }),
    )
  ).slice(0, 32);
  const now = Date.now();
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: input.env,
    namespace: input.env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok)
    throw new Error(`follow-up Connector unavailable: ${connector.error.code}`);
  await requireSessionExecution(input.execution, input.lease);
  const scheduled = await connector.value.scheduleSlackFollowUp({
    identity: {
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
    },
    sourceEventId: turnId.slice(SLACK_TURN_PREFIX.length),
    followUpId,
    dueAt: now + request.afterMinutes * 60_000,
  });
  if (!scheduled.ok)
    throw new Error(`follow-up not scheduled: ${scheduled.error.code}`);
  switch (scheduled.value.kind) {
    case "scheduled":
    case "duplicate":
      return {
        kind: "follow_up_scheduled",
        dueAt: new Date(scheduled.value.dueAt).toISOString(),
        afterMinutes: request.afterMinutes,
        detail:
          "A new turn starts in this thread at that time, for the same person. Tell them when you will come back.",
      };
    case "limit_reached":
      return {
        kind: "follow_up_not_scheduled",
        reason:
          "This thread already holds three follow-ups that wait. Tell the person that you cannot add another one now.",
      };
    default:
      return assertNever(scheduled.value);
  }
}

/**
 * Whether a turn may ask a person for permission: a Slack thread turn, whose
 * request continues in the thread, or a Portal chat step, whose chat pauses
 * on the request. Other turns have nobody to show a request to.
 */
export async function turnMayRequestPermission(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: string;
    authority: HarnessTurnLease["requestAuthority"];
    sessionId: string;
    turnId: string;
  }>,
): Promise<boolean> {
  if (turnMayScheduleFollowUp(input.authority, input.turnId)) return true;
  return (
    input.authority.kind === "control" &&
    (await isConversationSession(
      input.db,
      input.organisationId,
      input.sessionId,
    ))
  );
}

/**
 * Ask an owner or admin to allow what this turn lacks. In a Slack thread the
 * thread's Connector keeps this turn's command; a stored request names it,
 * and the thread gets one notice with a Portal link. When a person allows it,
 * the Connector queues the command again as a new turn. In a Portal chat the
 * stored request pauses the chat after this step, and the person allows it in
 * place. One call has one stable identity, so a replayed call stores and
 * posts nothing more.
 */
export async function requestPermissionForHarness(
  input: {
    readonly env: Env;
    readonly execution: SessionExecutionAdmission;
    readonly lease: HarnessTurnLease;
    readonly caseId: string;
  },
  request: HarnessPermissionRequest,
): Promise<HarnessPermissionRequestResult> {
  await requireSessionExecution(input.execution, input.lease);
  const authority = input.lease.requestAuthority;
  const sessionId = String(input.lease.session.sessionId);
  const turnId = String(input.lease.turn.turnId);
  const scope = input.execution.scope;
  if (
    (authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation" &&
      authority.kind !== "control") ||
    !(await turnMayRequestPermission({
      db: scope.database,
      organisationId: String(scope.organisationId),
      authority,
      sessionId,
      turnId,
    }))
  )
    throw new Error("permission request authority unavailable");
  if (!isRequesterRole(authority.role))
    throw new Error("permission requester role invalid");
  if (
    authority.kind === "shared_conversation" &&
    request.entityTypeReads.some(readNeedsPrivateChat)
  )
    return {
      kind: "permission_not_requested",
      reason:
        "Seams Pantry does not open orders, payments, shipments or stock policies to a shared channel. Tell the person to ask in a Portal chat or a direct message. Do not retry this denied read.",
    };
  const live = await validateLiveRequestAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(sessionId, turnId),
    action: "execute",
    authority,
  });
  if (!live.ok) throw new Error("permission request authority has changed");
  const capabilityIds = [...request.capabilityIds].sort();
  // A proposal grant covers the Organisation's shop, so a workspace without
  // a shop has nothing to allow.
  if (
    capabilityIds.includes(CAPABILITY_KEYS.commerceActionPropose) &&
    !(
      await resolveOrganisationCommerceSystemAuthority({
        db: scope.database,
        organisationId: scope.organisationId,
      })
    ).ok
  )
    return {
      kind: "permission_not_requested",
      reason:
        "This workspace has no connected shop, so there is nothing to propose a change to. Tell the person that an owner must connect a shop first.",
    };
  const now = Date.now();
  // The request asks only for the record-type reads that the requester lacks:
  // the reads that the agent named, and the read of the source record that a
  // draft edit capability cannot work without. When the check cannot run,
  // it keeps the reads that were named and leaves out the implied ones.
  const missing = await missingEntityTypeReads({
    db: scope.database,
    organisationId: scope.organisationId,
    requestAuthority: authority,
    reads: [
      ...new Set<RequestableEntityTypeRead>([
        ...request.entityTypeReads,
        ...impliedEntityTypeReads(capabilityIds),
      ]),
    ],
    causationId: turnId,
    now,
  });
  const entityTypeReads = [
    ...new Set<RequestableEntityTypeRead>(
      missing.ok ? missing.value.map(missingRead) : request.entityTypeReads,
    ),
  ].sort();
  if (capabilityIds.length + entityTypeReads.length === 0)
    return {
      kind: "permission_not_requested",
      reason:
        "This turn can already read what you named. Do the work now instead of asking.",
    };
  const requestId = (
    await sha256Hex(
      canonicalJson({ sessionId, turnId, capabilityIds, entityTypeReads }),
    )
  ).slice(0, 32);
  const asked = {
    requestId,
    sessionId,
    turnId,
    requesterPersonId: String(authority.requesterPersonId),
    requesterRole: authority.role,
    requestAuthority: authority,
    capabilityIds,
    entityTypeReads,
    createdAt: now,
  };
  if (authority.kind === "control") {
    await requireSessionExecution(input.execution, input.lease);
    const stored = await insertAgentPermissionRequest(scope, {
      ...asked,
      origin: { kind: "portal_chat" },
      caseId: input.caseId,
      requesterUserId: String(authority.userId),
    });
    if (!stored.ok) throw new Error("permission request not stored");
    return stored.value.kind === "case_busy"
      ? {
          kind: "permission_not_requested",
          reason:
            "A permission request in this chat already waits for an owner or admin. Tell the person that it waits, and do not ask again.",
        }
      : {
          kind: "permission_requested",
          detail:
            "Seams Pantry shows the person an Allow prompt in this chat. Tell them in one sentence that you asked, and that the request continues here after it is allowed. Do not do the work now.",
        };
  }
  const connectorId = parseConnectorId(String(authority.connectorId));
  if (!connectorId.ok)
    throw new Error("permission request Connector identity invalid");
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: input.env,
    namespace: input.env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok)
    throw new Error(
      `permission request Connector unavailable: ${connector.error.code}`,
    );
  const identity = {
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
  };
  await requireSessionExecution(input.execution, input.lease);
  const parked = await connector.value.parkSlackPermission({
    identity,
    sourceEventId: turnId.slice(SLACK_TURN_PREFIX.length),
    requestId,
  });
  if (!parked.ok)
    throw new Error(`permission request not kept: ${parked.error.code}`);
  const stored = await insertAgentPermissionRequest(scope, {
    ...asked,
    origin: {
      kind: "slack_thread",
      connectorId: connectorId.value,
      slackWorkspaceId: parked.value.workspaceId,
      slackChannelId: parked.value.channelId,
      slackThreadTs: parked.value.threadTs,
    },
    caseId: parked.value.caseId,
    requesterUserId: parked.value.requesterUserId,
  });
  if (!stored.ok) throw new Error(`permission request not stored`);
  if (stored.value.kind === "case_busy")
    return {
      kind: "permission_not_requested",
      reason:
        "A permission request in this thread already waits for an owner or admin. Tell the person that it waits, and do not ask again.",
    };
  const notice = await connector.value.noticeSlackPermission({
    identity,
    requestId,
    noticeText: permissionRequestNoticeText(capabilityIds, entityTypeReads),
    card: true,
  });
  return {
    kind: "permission_requested",
    detail:
      notice.ok && notice.value.notice === "posted"
        ? `Seams Pantry posted a card with this request and its buttons in this thread. Do not give a link. Do not do the work now. ${CARD_ONLY_REPLY_INSTRUCTION}`
        : "Seams Pantry stored the request, but the thread does not hold its link. Tell the person that you asked an owner or admin, who can allow it under Access in the Portal. Do not do the work now.",
  };
}

/**
 * A level block stopped a tool effect (Plan 27C). A turn cannot wait for days,
 * so an allowed pass lets this effect through, and otherwise Pantry asks a
 * person. In a Slack thread the turn parks, and an allow continues it in a new
 * turn. In a Portal chat the person allows it and asks again. A turn of no
 * person (a schedule, a mailbox, WhatsApp) has no later turn of this Session
 * to use a pass, so its effect stays refused.
 */
/**
 * Whether an allowed pass waits for this effect now; it asks nobody and
 * takes no pass (Plan 40B phase 7, the board draft preview).
 */
export async function exitApprovalPassReady(
  input: Readonly<{
    execution: SessionExecutionAdmission;
    lease: HarnessTurnLease;
    effect: Readonly<{
      capabilityId: string;
      integrationAccountId: string;
      resourceScope: string;
    }>;
    flowLabel: FlowLabel;
    repeatInRequest: boolean;
    reason: HeldOutputReason;
    action: EffectAction | null;
  }>,
): Promise<boolean> {
  const authority = input.lease.requestAuthority;
  const action =
    input.reason === "outside_written" && input.action !== null
      ? await heldEffectActionRecord(input.action)
      : null;
  return hasHeldEffectPass(
    input.execution.scope,
    {
      sessionId: String(input.lease.session.sessionId),
      capabilityId: input.effect.capabilityId,
      integrationAccountId: input.effect.integrationAccountId,
      resourceScope: input.effect.resourceScope,
    },
    Date.now(),
    authority.kind === "control" ? String(authority.requesterPersonId) : null,
    passUse(
      input.lease,
      input.flowLabel,
      input.repeatInRequest,
      input.reason,
      action?.digest ?? null,
    ),
  );
}

/**
 * How this turn may use a pass: the content of each use is no more than the
 * content that the person allowed, so joining its label to the allowed one
 * changes nothing. For a board edit, one Allow covers the turn's later edits
 * (Plan 40B phase 7).
 */
function passUse(
  lease: HarnessTurnLease,
  flowLabel: FlowLabel,
  repeatInRequest: boolean,
  reason: HeldOutputReason,
  actionDigest: string | null,
): HeldEffectPassUse {
  return {
    turnId: String(lease.turn.turnId),
    repeatInRequest,
    outsideWritten: reason === "outside_written" ? { actionDigest } : null,
    covers: async (allowedFlowLabelJson) => {
      // The person saw this exact action, and the pass matches its digest. A
      // later request can carry more of the person's own context, which does
      // not change what they allowed (Plan 89).
      if (reason === "outside_written" && actionDigest !== null) return true;
      let raw: unknown;
      try {
        raw = JSON.parse(allowedFlowLabelJson);
      } catch {
        return false;
      }
      const allowed = await FlowLabel.restore(raw);
      if (!allowed.ok) return false;
      const joined = await joinFlowLabels(allowed.value, flowLabel);
      return joined.ok && joined.value.digest === allowed.value.digest;
    },
  };
}

export async function passOrAskForExitApproval(
  input: Readonly<{
    env: Env;
    execution: SessionExecutionAdmission;
    lease: HarnessTurnLease;
    effect: Readonly<{
      capabilityId: string;
      integrationAccountId: string;
      resourceScope: string;
    }>;
    flowLabel: FlowLabel;
    reason: HeldOutputReason;
    /** A board edit: one Allow covers the turn's later edits. */
    repeatInRequest?: boolean;
    /**
     * The action, for a step that waits because the Session read
     * outside-written text. The person sees it, and the pass matches it.
     */
    action?: EffectAction | null;
  }>,
): Promise<boolean> {
  const { env, lease, effect } = input;
  const scope = input.execution.scope;
  const sessionId = String(lease.session.sessionId);
  const turnId = String(lease.turn.turnId);
  const authority = lease.requestAuthority;
  const now = Date.now();
  await requireSessionExecution(input.execution, lease);
  const action =
    input.reason === "outside_written" &&
    input.action !== undefined &&
    input.action !== null
      ? await heldEffectActionRecord(input.action)
      : null;
  const held = {
    sessionId,
    authorityPartitionDigest: String(lease.authorityPartitionDigest),
    capabilityId: effect.capabilityId,
    integrationAccountId: effect.integrationAccountId,
    resourceScope: effect.resourceScope,
    consumedAt: null,
    action:
      action === null ? null : { digest: action.digest, view: action.action },
  };
  if (
    await consumeHeldEffectPass(
      scope,
      held,
      now,
      authority.kind === "control" ? String(authority.requesterPersonId) : null,
      passUse(
        lease,
        input.flowLabel,
        input.repeatInRequest === true,
        input.reason,
        action?.digest ?? null,
      ),
    )
  )
    return true;
  if (
    authority.kind !== "control" &&
    !(
      authority.kind === "direct_conversation" ||
      authority.kind === "shared_conversation"
    )
  )
    return false;
  if (
    authority.kind !== "control" &&
    !turnMayScheduleFollowUp(authority, turnId)
  )
    return false;
  const requestId = (
    await sha256Hex(
      canonicalJson({
        sessionId,
        turnId,
        capabilityId: effect.capabilityId,
        integrationAccountId: effect.integrationAccountId,
        resourceScope: effect.resourceScope,
        // Two actions of one turn are two requests.
        reason: input.reason,
        actionDigest: action?.digest ?? null,
      }),
    )
  ).slice(0, 32);
  const asked = {
    requestId,
    subject: "effect" as const,
    outputId: null,
    effect: held,
    reason: input.reason,
    requesterPersonId: String(authority.requesterPersonId),
    requestAuthority: authority,
    flowLabelJson: JSON.stringify(input.flowLabel.toJSON()),
    createdAt: now,
  };
  if (authority.kind === "control") {
    const stored = await insertHeldOutputRequest(scope, {
      ...asked,
      caseId: null,
      connectorId: null,
      channelId: null,
    });
    if (!stored.ok) throw new Error("exit approval not stored");
    throw new ExitApprovalRequestedError(
      input.reason === "outside_written"
        ? "Seams Pantry stopped this step, because this conversation read text that a person outside the Organisation wrote, and this step changes something. It shows the person the exact step in a permission request in this chat; the request also waits under Permission requests in the account menu. Tell the person in one or two sentences what the step is. They can ask you again after they allow it, and the step must then be the same. Do not try this step again in this turn."
        : "Seams Pantry stopped this step, because it uses content that this destination may not receive. It shows the person a permission request in this chat; the request also waits under Permission requests in the account menu. Tell the person in one or two sentences. They can ask you again after they allow it. Do not try this step again in this turn.",
    );
  }
  const connectorId = parseConnectorId(String(authority.connectorId));
  if (!connectorId.ok) throw new Error("exit approval Connector invalid");
  const connector = await resolveActiveConnectorActorAtPlacement({
    env,
    namespace: env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now,
  });
  if (!connector.ok)
    throw new Error(`exit approval Connector: ${connector.error.code}`);
  const identity = {
    organisationId: scope.organisationId,
    connectorId: connectorId.value,
  };
  const parked = await connector.value.parkSlackPermission({
    identity,
    sourceEventId: turnId.slice(SLACK_TURN_PREFIX.length),
    requestId,
  });
  if (!parked.ok)
    throw new Error(`exit approval not kept: ${parked.error.code}`);
  const stored = await insertHeldOutputRequest(scope, {
    ...asked,
    caseId: parked.value.caseId,
    connectorId: connectorId.value,
    channelId: parked.value.channelId,
  });
  if (!stored.ok) throw new Error("exit approval not stored");
  await connector.value.noticeSlackPermission({
    identity,
    requestId,
    noticeText: heldEffectNoticeText(input.reason),
  });
  throw new ExitApprovalRequestedError(
    input.reason === "outside_written"
      ? `Seams Pantry stopped this step, because this conversation read text that a person outside the Organisation wrote, and this step changes something. It posted a card with this request in this thread, and the request continues here after it is allowed. The step must then be the same. Do not give a link. Do not try this step again in this turn. ${CARD_ONLY_REPLY_INSTRUCTION}`
      : `Seams Pantry stopped this step, because it uses content that this destination may not receive. It posted a card with this request in this thread, and the step continues here after it is allowed. Do not give a link. Do not try this step again in this turn. ${CARD_ONLY_REPLY_INSTRUCTION}`,
  );
}

function missingRead(
  missing: MissingEntityTypeRead,
): RequestableEntityTypeRead {
  return missing.read;
}
