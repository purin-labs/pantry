import { errorMessage } from "@seams/std";

import { errorResponse, jsonResponse } from "../http";
import { newRequestId, type RequestId } from "../ids";
import { traceLog, traceWarn } from "../observability";
import { setSlackThreadStatus } from "../slack/messages";
import { SLACK_INTERACTIONS_PATH } from "../gateway-routing/slack";
import { isSlackCaseRoutingCandidate } from "../slack/case-routing";
import {
  decideSlackCaseAtConnector,
  type ConnectorSlackIngressBindings,
} from "../slack/connector-ingress";
import {
  parseSlackEnvelope,
  slackAuthoredText,
  type SlackMessageEvent,
} from "../slack/events";
import {
  resolveSlackCaseIngressRoute,
  type PendingSlackIngressCredential,
} from "../slack/ingress-admission";
import {
  resolveConfiguredSlackInstallationIdentity,
  type SlackInstallationIdentity,
} from "../slack/installation-identity";
import type { ResolvedSlackThreadRoute } from "../slack/organisation-routing";
import { verifySlackSignature } from "../slack/signature";
import { isSlackStopCommand } from "../slack/stop-command";
import { parseSupplierPayoutQuery } from "../slack/supplier-payout-command";

/**
 * The bindings of the Slack ingress Worker. It holds no Actor class and no
 * portal. It reads the thread route, calls the Connector of the platform
 * Worker, and gives every other request to the platform Worker.
 */
export type SlackIngressEnv = ConnectorSlackIngressBindings & {
  readonly SLACK_SIGNING_SECRET?: string;
  readonly PANTRY_DEPLOYMENT_PROFILE?: string;
  readonly SLACK_APP_ID?: string;
  /** The platform Worker, which takes what this Worker does not complete. */
  readonly PLATFORM: Pick<Fetcher, "fetch">;
};

/**
 * Take one request for the Slack event address.
 *
 * A new isolate of the platform Worker loads the whole platform before it
 * answers its first request. This Worker loads only the path below, so a
 * Slack message reaches its Connector sooner.
 *
 * It completes one case: a signed message that routes to a Case whose
 * Connector serves the published placement, and that the Connector accepts.
 * The Connector makes that decision, as it does for the platform Worker.
 * Every other request for the Slack event address goes to the platform
 * Worker unchanged, and the platform Worker decides it as before. A request
 * for another path gets no answer from the platform.
 *
 * This Worker refuses nothing. It holds a copy of the Slack signing secret,
 * and the platform Worker holds the secret that counts. A request that the
 * copy does not verify goes to the platform Worker, which refuses a forged
 * request. A missing or outdated copy therefore only removes the gain.
 *
 * Slack also sends the clicks on Pantry's buttons to this Worker's
 * interactions address (Plan 74). They go to the platform Worker unchanged,
 * which verifies the signature and answers.
 */
export async function handleSlackIngress(
  request: Request,
  env: SlackIngressEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  // This Worker serves the two Slack addresses and no other path, so it is
  // not a second address of the platform.
  const path = new URL(request.url).pathname;
  if (path === SLACK_INTERACTIONS_PATH) return env.PLATFORM.fetch(request);
  if (path !== "/slack/events")
    return errorResponse("not_found", "Not found.", 404);
  if (request.method !== "POST") return env.PLATFORM.fetch(request);

  const receivedAt = Date.now();
  const rawBody = await request.text();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim() ?? "";
  // This Worker decides nothing without its copy of the secret.
  if (signingSecret.length === 0) return passToPlatform(env, request, rawBody);

  const requestId = newRequestId();
  const verified = await verifySlackSignature(
    request.headers,
    rawBody,
    signingSecret,
    receivedAt,
  );
  if (!verified.ok) {
    traceWarn("integration_gateway.slack.ingress_signature_unverified", {
      requestId,
      reason: verified.reason,
    });
    return passToPlatform(env, request, rawBody);
  }

  const event = fastPathEvent(rawBody);
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (event === null || !installationIdentity.ok)
    return passToPlatform(env, request, rawBody);

  const fast = await acceptAtConnector(
    env,
    event,
    requestId,
    receivedAt,
    installationIdentity.value,
  );
  // The platform Worker shows the prompt of a refused message, retries, and
  // activates a Connector that does not serve the placement yet. It asks the
  // Connector again, and the Connector gives the same answer. A Connector
  // that accepted the message before a failure answers it as a duplicate.
  if (fast === null) return passToPlatform(env, request, rawBody);

  ctx.waitUntil(
    showSlackProgress(event, requestId, receivedAt, fast.slackCredential),
  );
  traceLog("integration_gateway.slack.case_accepted", {
    requestId,
    organisation_id: fast.route.organisationId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    event_id: event.eventId,
    case_id: fast.route.caseId,
    disposition: fast.disposition,
    admitted_by: "connector",
    ingress_worker: "slack_ingress",
    elapsed_ms: Date.now() - receivedAt,
  });
  traceLog("integration_gateway.slack.ack", {
    requestId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    event_id: event.eventId,
    durable_mode: "case_accepted",
  });
  return jsonResponse({
    ok: true,
    requestId,
    durableMode: "case_accepted",
  });
}

type FastAcceptance = {
  readonly route: ResolvedSlackThreadRoute;
  readonly disposition: "accepted" | "duplicate";
  readonly slackCredential: PendingSlackIngressCredential;
};

/**
 * Route the message and ask its Connector to accept it. Null when the
 * Connector did not accept it, and when a read or the call failed. The
 * platform Worker then decides the message.
 */
async function acceptAtConnector(
  env: SlackIngressEnv,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  installationIdentity: SlackInstallationIdentity,
): Promise<FastAcceptance | null> {
  try {
    const routing = await resolveSlackCaseIngressRoute({
      db: env.DB,
      event,
      occurredAt: receivedAt,
      installationIdentity,
    });
    if (routing.kind !== "routed") return null;
    const decided = await decideSlackCaseAtConnector(
      env,
      event,
      requestId,
      receivedAt,
      routing.route,
    );
    if (decided === null) return null;
    const disposition = decided.outcome.kind;
    return disposition === "accepted" || disposition === "duplicate"
      ? {
          route: routing.route,
          disposition,
          slackCredential: decided.slackCredential,
        }
      : null;
  } catch (error) {
    traceWarn("integration_gateway.slack.ingress_fast_path_failed", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      event_id: event.eventId,
      detail: errorMessage(error),
    });
    return null;
  }
}

/**
 * The message of a request that this Worker can complete. Null for every
 * other request: a challenge, an ignored event, a revoked installation, a
 * message that opens no Case, a stop command and a supplier payout question.
 */
function fastPathEvent(rawBody: string): SlackMessageEvent | null {
  const parsed = parseSlackEnvelope(rawBody);
  if (!parsed.ok || parsed.value.kind !== "message") return null;
  const event = parsed.value.event;
  const authored = {
    trigger: event.trigger,
    text: slackAuthoredText(event.authored),
  };
  return isSlackCaseRoutingCandidate(event) &&
    !isSlackStopCommand(authored) &&
    parseSupplierPayoutQuery(authored) === null
    ? event
    : null;
}

/** Give the request to the platform Worker with the body that was read. */
function passToPlatform(
  env: SlackIngressEnv,
  request: Request,
  rawBody: string,
): Promise<Response> {
  return env.PLATFORM.fetch(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: rawBody,
    }),
  );
}

/**
 * Show the thinking status in the thread of an accepted message. The
 * credential resolved beside the Connector's decision, after its placement
 * fence was read again.
 */
async function showSlackProgress(
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  pending: PendingSlackIngressCredential,
): Promise<void> {
  const admissionStartedAt = Date.now();
  const slackCredential = await pending;
  const credentialResolvedAt = Date.now();
  if (slackCredential.kind !== "ready") {
    traceWarn("integration_gateway.slack_progress_unavailable", {
      requestId,
      channel_id: event.channelId,
      elapsed_ms: credentialResolvedAt - receivedAt,
      admission_elapsed_ms: credentialResolvedAt - admissionStartedAt,
      detail: slackCredential.reason,
    });
    return;
  }
  const status = await setSlackThreadStatus({
    token: slackCredential.token,
    channelId: event.channelId,
    threadTs: event.threadTs,
    status: "is thinking…",
  });
  const trace = {
    requestId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    elapsed_ms: Date.now() - receivedAt,
    admission_elapsed_ms: credentialResolvedAt - admissionStartedAt,
    slack_api_elapsed_ms: Date.now() - credentialResolvedAt,
  };
  if (status.ok) traceLog("integration_gateway.slack_progress_visible", trace);
  else
    traceWarn("integration_gateway.slack_progress_unavailable", {
      ...trace,
      detail: status.error.detail,
    });
}
