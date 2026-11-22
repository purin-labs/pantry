import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import {
  listHeldAgentPermissionDecisions,
  markAgentPermissionRequestReleased,
  type AgentPermissionRequest,
} from "../data/agent-permission-request";
import type { Env } from "@purin-labs/kernel/env";
import { parseConnectorId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { refreshSlackRequestAuthority } from "../request-authority";
import { permissionDecisionNoticeText } from "./permission-request-notice";

/**
 * Hand a decided request to its asking turn and record that it arrived. A
 * Slack request continues or stops in its thread through the Connector. A
 * Portal chat request has nothing parked: its chat checks the decision when
 * the person resumes or stops the paused run.
 *
 * It returns false when the Slack request could not reach its thread now,
 * for example while the Slack connection needs attention. The decision stays
 * stored, and the scheduled reconciliation hands it over once Slack works.
 */
export async function releaseAgentPermissionDecision(
  env: Env,
  scope: OrganisationExecutionScope,
  stored: AgentPermissionRequest,
): Promise<boolean> {
  if (stored.status === "pending") return false;
  if (stored.releasedAt !== null) return true;
  const released =
    stored.origin.kind === "portal_chat" ||
    (await releaseParkedSlackRequest(env, scope, stored).catch(() => false));
  if (released)
    await markAgentPermissionRequestReleased(
      scope,
      stored.requestId,
      Date.now(),
    );
  return released;
}

/** Hand over the Slack decisions that waited for a working Slack connection. */
export async function reconcileHeldPermissionDecisions(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<void> {
  const held = await listHeldAgentPermissionDecisions(
    input.scope.database,
    input.scope.organisationId,
    input.now,
  );
  for (const stored of held)
    await releaseAgentPermissionDecision(input.env, input.scope, stored);
}

async function releaseParkedSlackRequest(
  env: Env,
  scope: OrganisationExecutionScope,
  stored: AgentPermissionRequest,
): Promise<boolean> {
  if (stored.origin.kind !== "slack_thread") return false;
  const decision = stored.status === "allowed" ? "allow" : "deny";
  const connectorId = parseConnectorId(stored.origin.connectorId);
  if (!connectorId.ok) return false;
  const connector = await resolveActiveConnectorActorAtPlacement({
    env,
    namespace: env.CONNECTOR,
    organisationId: scope.organisationId,
    placement: scope.placement,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) return false;
  let requestAuthority = null;
  if (decision === "allow") {
    const asked = stored.requestAuthority;
    if (
      asked.kind !== "direct_conversation" &&
      asked.kind !== "shared_conversation"
    )
      return false;
    // Null while the Slack account is not active, or the requester left.
    requestAuthority = await refreshSlackRequestAuthority(
      scope.database,
      asked,
    );
    if (requestAuthority === null) return false;
  }
  const released = await connector.value.releaseSlackPermission({
    identity: {
      organisationId: scope.organisationId,
      connectorId: connectorId.value,
    },
    requestId: stored.requestId,
    decision,
    requestAuthority,
    noticeText: permissionDecisionNoticeText(decision),
    card: true,
  });
  return released.ok;
}
