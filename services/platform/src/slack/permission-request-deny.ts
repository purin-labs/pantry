import { errorMessage } from "@seams/std";

import { resolveSlackApprover } from "../actors/action-mutation-execution";
import {
  AGENT_PERMISSION_REQUEST_LIFETIME_MS,
  decideAgentPermissionRequest,
  readAgentPermissionRequest,
} from "../data/agent-permission-request";
import type { Env } from "../env";
import type { OrganisationId, RequestId } from "../ids";
import { traceLog, traceWarn } from "../observability";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { RequestDeadline } from "../request-deadline";
import { releaseAgentPermissionDecision } from "./permission-request-release";

const DENY_FAILED =
  "The server could not record your decision. Click Deny again, or decide under Access in the Portal.";

/**
 * Deny a permission request from its Slack card. Only an owner or admin whose
 * Slack user has a verified link may deny. A denial grants nothing, so the
 * click is enough proof. The Connector then updates the card and stops the
 * request; a refusal goes only to the person who clicked.
 */
export async function denyPermissionRequestFromSlack(
  env: Env,
  click: Readonly<{
    organisationId: OrganisationId;
    integrationAccountId: string;
    workspaceId: string;
    slackUserId: string;
    permissionRequestId: string;
    responseUrl: string;
    requestId: RequestId;
  }>,
): Promise<void> {
  const refusal = await deny(env, click).catch((error: unknown) => {
    traceWarn("integration_gateway.slack.permission_deny_failed", {
      requestId: click.requestId,
      organisation_id: click.organisationId,
      detail: errorMessage(error),
    });
    return DENY_FAILED;
  });
  traceLog("integration_gateway.slack.permission_deny", {
    requestId: click.requestId,
    organisation_id: click.organisationId,
    outcome: refusal === null ? "denied" : "refused",
  });
  if (refusal !== null) await tellClicker(click.responseUrl, refusal);
}

async function deny(
  env: Env,
  click: Parameters<typeof denyPermissionRequestFromSlack>[1],
): Promise<string | null> {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    click.organisationId,
  );
  if (!scope.ok) return DENY_FAILED;
  const approver = await resolveSlackApprover(scope.value.database, {
    organisationId: click.organisationId,
    integrationAccountId: click.integrationAccountId,
    workspaceId: click.workspaceId,
    slackUserId: click.slackUserId,
  });
  if (approver === null)
    return "Only an owner or admin whose Slack account is linked to Seams Pantry can deny this request.";
  const stored = await readAgentPermissionRequest(
    scope.value.database,
    click.organisationId,
    click.permissionRequestId,
  );
  if (stored === null) return DENY_FAILED;
  const now = Date.now();
  if (
    stored.status === "pending" &&
    stored.createdAt + AGENT_PERMISSION_REQUEST_LIFETIME_MS < now
  )
    return "This request expired. Sous Chef stopped it.";
  if (stored.status === "allowed")
    return "An owner or admin already allowed this request.";
  const decided =
    stored.status === "pending"
      ? await decideAgentPermissionRequest(scope.value, {
          requestId: stored.requestId,
          status: "denied",
          userId: approver.userId,
          now,
        })
      : { ok: true as const, value: stored };
  if (!decided.ok) return DENY_FAILED;
  if (decided.value.status !== "denied")
    return "An owner or admin already allowed this request.";
  // The decision is stored. When Slack cannot take it now, the scheduled
  // reconciliation hands it to the thread once Slack works.
  await releaseAgentPermissionDecision(env, scope.value, decided.value);
  return null;
}

/** A message that only the person who clicked sees. */
async function tellClicker(responseUrl: string, text: string): Promise<void> {
  const deadline = new RequestDeadline(5_000);
  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      signal: deadline.signal,
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text,
      }),
    });
    await response.body?.cancel();
  } catch {
    // The click has no other answer; the card still shows the request.
  } finally {
    deadline.end();
  }
}
