import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { authorizeCloudflareAuthoritativeMutation } from "../data/authoritative-runtime-cutover";
import { issueIdentityLink } from "../data/identity-link";
import type { Env } from "../env";
import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
} from "../http";
import type { SlackCaseCommand } from "../ingress-queue";
import {
  newRequestId,
  type RequestId,
} from "../ids";
import {
  traceLog,
  traceWarn,
} from "../observability";
import type { Result } from "../result";
import {
  parseSlackEnvelope,
  slackAuthoredText,
  type SlackMessageEvent,
} from "../slack/events";
import { setSlackThreadStatus } from "../slack/messages";
import { isSlackStopCommand } from "../slack/stop-command";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import {
  parseSupplierPayoutQuery,
  type SupplierPayoutQuery,
} from "../slack/supplier-payout-command";
import { replyToSupplierPayoutQuery } from "../slack/supplier-payout-reply";
import {
  postSlackThreadMessage,
  slackClientMessageId,
} from "../slack/messages";
import { isSlackCaseRoutingCandidate } from "../slack/case-routing";
import { decideSlackCaseAtConnector } from "../slack/connector-ingress";
import type { ResolvedSlackThreadRoute } from "../slack/organisation-routing";
import {
  authorizeResolvedSlackCaseIngress,
  resolveSlackCaseIngressRoute,
  slackEventAccountAuthority,
  type AuthorizedSlackCaseIngress,
  type PendingSlackIngressCredential,
  type SlackCaseIngress,
  type SlackCaseIngressAdmission,
  type SlackIngressCredential,
} from "../slack/ingress-admission";
import { buildAdmittedSlackCaseCommand } from "../slack/case-command";
import { verifySlackSignature } from "../slack/signature";
import { resolveActiveSlackPhysicalInstallationCredential } from "../credential-vault";
import type { Variant } from "@seams/type-utils";
import {
  assertNever,
  isRecord,
} from "@seams/std";
import {
  handleSlackInstallationRevoked,
  identityLinkBrowserUrl,
  readRuntimeSecret,
  slackPayloadErrorResponse,
} from "../gateway/support";

export type SlackDurableAccept =
  | { mode: "case_accepted" }
  | { mode: "supplier_payout_answered" }
  | { mode: "ignored"; reason: "ambient_message" | "stop_command_unsupported" }
  | {
      mode: "rejected";
      reason:
        | "organisation_inactive"
        | "install_inactive"
        | "runtime_not_authoritative"
        | "mutation_precedes_activation"
        | "destination_missing"
        | "case_missing"
        | "identity_link_missing"
        | "organisation_membership_missing"
        | "command_not_permitted";
    };

export type SlackDurableAcceptError = {
  code: "slack_event_not_durable";
  detail: string;
};

export async function handleSlackEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const requestId = newRequestId();
  const receivedAt = Date.now();
  const rawBody = await request.text();
  const signingSecret = readRuntimeSecret(env.SLACK_SIGNING_SECRET);

  if (!signingSecret.ok) {
    traceWarn("integration_gateway.slack.missing_signing_secret", {
      requestId,
    });

    return errorResponse(
      "missing_slack_signing_secret",
      "Slack signing secret is not configured.",
      500,
    );
  }

  const verified = await verifySlackSignature(
    request.headers,
    rawBody,
    signingSecret.value,
    receivedAt,
  );

  if (!verified.ok) {
    traceWarn("integration_gateway.slack.signature_rejected", {
      requestId,
      reason: verified.reason,
    });

    return errorResponse(
      "invalid_slack_signature",
      "Slack signature verification failed.",
      401,
    );
  }

  const parsed = parseSlackEnvelope(rawBody);

  if (!parsed.ok) {
    return slackPayloadErrorResponse(parsed.error);
  }

  switch (parsed.value.kind) {
    case "url_verification":
      return jsonResponse({ challenge: parsed.value.challenge });
    case "ignored":
      traceLog("integration_gateway.slack.ignored", {
        requestId,
        reason: parsed.value.reason,
      });

      return jsonResponse({
        ok: true,
        requestId,
        ignored: parsed.value.reason,
      });
    case "installation_revoked":
      return handleSlackInstallationRevoked(
        env,
        parsed.value.event,
        requestId,
        receivedAt,
      );
    case "message":
      const preparation = prepareSlackEventAdmission(
        env,
        parsed.value.event,
        requestId,
        receivedAt,
      );
      if (shouldShowSlackIngressProgress(parsed.value.event)) {
        ctx.waitUntil(
          showSlackIngressProgress(
            env,
            parsed.value.event,
            requestId,
            receivedAt,
            preparation,
          ),
        );
      }
      const accepted = await durablyAcceptSlackMessage(
        parsed.value.event,
        preparation,
      );

      if (!accepted.ok) {
        traceWarn("integration_gateway.slack.durable_accept_failed", {
          requestId,
          workspace_id: parsed.value.event.workspaceId,
          channel_id: parsed.value.event.channelId,
          event_id: parsed.value.event.eventId,
          detail: accepted.error.detail,
        });

        return errorResponse(
          accepted.error.code,
          "Slack event was not durably accepted.",
          503,
        );
      }

      traceLog("integration_gateway.slack.ack", {
        requestId,
        workspace_id: parsed.value.event.workspaceId,
        channel_id: parsed.value.event.channelId,
        event_id: parsed.value.event.eventId,
        durable_mode: accepted.value.mode,
      });

      return jsonResponse({
        ok: true,
        requestId,
        durableMode: accepted.value.mode,
      });
    default:
      return assertNever(parsed.value);
  }
}

export async function durablyAcceptSlackMessage(
  event: SlackMessageEvent,
  preparation: SlackEventAdmissionPreparation,
): Promise<Result<SlackDurableAccept, SlackDurableAcceptError>> {
  switch (preparation.kind) {
    case "standard":
      return acceptStandardSlackMessage(event);
    case "case_candidate":
      return (await preparation.ingress).accepted;
    default:
      return assertNever(preparation);
  }
}

export function acceptStandardSlackMessage(
  event: SlackMessageEvent,
): Result<SlackDurableAccept, SlackDurableAcceptError> {
  return isSlackStopCommand({
    trigger: event.trigger,
    text: slackAuthoredText(event.authored),
  })
    ? {
        ok: true,
        value: { mode: "ignored", reason: "stop_command_unsupported" },
      }
    : { ok: true, value: { mode: "ignored", reason: "ambient_message" } };
}

/**
 * One Slack Case message on its way to durable acceptance. The admission view
 * is known when this value exists. Acceptance can settle later.
 */
export type SlackCaseIngressFlow = {
  readonly admission: SlackCaseIngressAdmissionView;
  readonly slackCredential: PendingSlackIngressCredential | null;
  readonly accepted: Promise<
    Result<SlackDurableAccept, SlackDurableAcceptError>
  >;
};

export type UnadmittedSlackCaseIngress = Variant<
  SlackCaseIngressAdmission,
  "identity_link_required" | "rejected" | "retry"
>;

export type SlackCaseIngressAdmissionView =
  { readonly kind: "authorized" } | UnadmittedSlackCaseIngress;

/**
 * Route one Slack Case message to durable acceptance. A message whose
 * Connector already serves the published placement is decided inside that
 * Connector, beside the organisation's records. Every other message, and every
 * answer the Worker gives itself, is decided here.
 */
export async function resolveSlackCaseIngress(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
): Promise<SlackCaseIngressFlow> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.SATYR_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return settledSlackCaseIngress({
      kind: "retry",
      code: "slack_installation_identity_unconfigured",
    });
  }
  const routing = await resolveSlackCaseIngressRoute({
    db: env.DB,
    event,
    occurredAt: receivedAt,
    installationIdentity: installationIdentity.value,
  });
  if (routing.kind !== "routed") return settledSlackCaseIngress(routing);
  const payoutQuery = parseSupplierPayoutQuery({
    trigger: event.trigger,
    text: slackAuthoredText(event.authored),
  });
  if (payoutQuery === null) {
    const decided = await admitSlackCaseWorkInConnector(
      env,
      event,
      requestId,
      receivedAt,
      routing.route,
    );
    if (decided !== null) return decided;
  }
  const ingress = await authorizeResolvedSlackCaseIngress({
    env,
    keys: env,
    event,
    occurredAt: receivedAt,
    route: routing.route,
  });
  if (ingress.admission.kind !== "authorized") {
    traceUnadmittedSlackCase(
      requestId,
      event,
      routing.route,
      "worker",
      ingress.admission,
    );
  }
  return {
    admission:
      ingress.admission.kind === "authorized"
        ? { kind: "authorized" }
        : ingress.admission,
    slackCredential: ingress.slackCredential,
    accepted: acceptSlackCaseCandidate(
      env,
      event,
      requestId,
      receivedAt,
      ingress,
      payoutQuery,
    ),
  };
}

/**
 * Hand the message to its Connector for admission and acceptance. Returns
 * null when no Connector serves the published placement, so the caller
 * decides the message and activates one.
 */
export async function admitSlackCaseWorkInConnector(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  route: ResolvedSlackThreadRoute,
): Promise<SlackCaseIngressFlow | null> {
  // The call is shared with the Slack ingress Worker. The bot credential
  // resolves beside it. An authorized decision and a decision that answers the
  // person use it, and any other outcome drops it unread.
  const decided = await decideSlackCaseAtConnector(
    env,
    event,
    requestId,
    receivedAt,
    route,
  );
  if (decided === null) return null;
  const { outcome, slackCredential } = decided;
  switch (outcome.kind) {
    case "accepted":
    case "duplicate":
      traceLog("integration_gateway.slack.case_accepted", {
        requestId,
        organisation_id: route.organisationId,
        workspace_id: event.workspaceId,
        channel_id: event.channelId,
        event_id: event.eventId,
        case_id: route.caseId,
        disposition: outcome.kind,
        admitted_by: "connector",
        elapsed_ms: Date.now() - receivedAt,
      });
      return {
        admission: { kind: "authorized" },
        slackCredential,
        accepted: Promise.resolve({
          ok: true,
          value: { mode: "case_accepted" },
        }),
      };
    case "identity_link_required":
      return refusedByConnector(
        { kind: "identity_link_required", value: outcome.value },
        slackCredential,
      );
    case "rejected":
      return refusedByConnector(
        { kind: "rejected", reason: outcome.reason },
        outcome.reason === "command_not_permitted" ? slackCredential : null,
      );
    case "retry":
      return refusedByConnector({ kind: "retry", code: outcome.code }, null);
    default:
      return assertNever(outcome);
  }

  function refusedByConnector(
    admission: UnadmittedSlackCaseIngress,
    slackCredential: PendingSlackIngressCredential | null,
  ): SlackCaseIngressFlow {
    traceUnadmittedSlackCase(requestId, event, route, "connector", admission);
    return settledSlackCaseIngress(admission, slackCredential);
  }
}

export function traceUnadmittedSlackCase(
  requestId: RequestId,
  event: SlackMessageEvent,
  route: ResolvedSlackThreadRoute,
  decidedBy: "connector" | "worker",
  admission: UnadmittedSlackCaseIngress,
): void {
  traceLog("integration_gateway.slack.case_unadmitted", {
    requestId,
    organisation_id: route.organisationId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    event_id: event.eventId,
    case_id: route.caseId,
    outcome: admission.kind,
    detail: unadmittedSlackCaseDetail(admission),
    decided_by: decidedBy,
  });
}

export function unadmittedSlackCaseDetail(
  admission: UnadmittedSlackCaseIngress,
): string {
  switch (admission.kind) {
    case "identity_link_required":
      return "identity_link_missing";
    case "rejected":
      return admission.reason;
    case "retry":
      return admission.code;
    default:
      return assertNever(admission);
  }
}

export function settledSlackCaseIngress(
  admission: UnadmittedSlackCaseIngress,
  slackCredential: PendingSlackIngressCredential | null = null,
): SlackCaseIngressFlow {
  return {
    admission,
    slackCredential,
    accepted: Promise.resolve(unadmittedSlackDurableAccept(admission)),
  };
}

export function unadmittedSlackDurableAccept(
  admission: UnadmittedSlackCaseIngress,
): Result<SlackDurableAccept, SlackDurableAcceptError> {
  switch (admission.kind) {
    case "identity_link_required":
      return {
        ok: true,
        value: { mode: "rejected", reason: "identity_link_missing" },
      };
    case "rejected":
      return {
        ok: true,
        value: { mode: "rejected", reason: admission.reason },
      };
    case "retry":
      return {
        ok: false,
        error: { code: "slack_event_not_durable", detail: admission.code },
      };
    default:
      return assertNever(admission);
  }
}

/**
 * Answer a supplier-payout question in the thread that asked it.
 *
 * The reply goes back to the conversation the question came from and nowhere
 * else. A payout figure sent to a channel other than the one that asked would
 * be a disclosure nobody requested. The figures are posted only when that
 * conversation's audience passes the conversation sink; otherwise the thread
 * gets the fixed refusal.
 */
export async function answerSupplierPayoutQuery(
  env: Env,
  event: SlackMessageEvent,
  admission: AuthorizedSlackCaseIngress,
  command: SlackCaseCommand,
  pendingCredential: PendingSlackIngressCredential | null,
  query: SupplierPayoutQuery,
  requestId: RequestId,
  receivedAt: number,
): Promise<Result<SlackDurableAccept, SlackDurableAcceptError>> {
  const slackCredential = await pendingCredential;
  if (slackCredential === null || slackCredential.kind !== "ready") {
    return {
      ok: false,
      error: {
        code: "slack_event_not_durable",
        detail: "slack_credential_unavailable",
      },
    };
  }
  const execution = await OrganisationExecutionScope.resolveAtPlacement(
    env,
    admission.organisationId,
    admission.placement,
  );
  if (!execution.ok) {
    return {
      ok: false,
      error: { code: "slack_event_not_durable", detail: execution.error.code },
    };
  }
  const replyKey = `supplier-payout:${event.channelId}:${event.messageTs}`;
  const reply = await replyToSupplierPayoutQuery({
    env,
    scope: execution.value,
    membershipRole: admission.membershipRole,
    requestAuthority: command.requestAuthority,
    userAuthority: slackEventAccountAuthority(
      event,
      admission.integrationAccountId,
    ),
    channelId: event.channelId,
    sessionId: admission.sessionId,
    replyId: replyKey,
    query,
    now: receivedAt,
  });
  const text =
    reply.kind === "answer"
      ? reply.text
      : "This workspace is not permitted to read supplier payouts.";
  const posted = await postSlackThreadMessage({
    token: slackCredential.token,
    channelId: event.channelId,
    threadTs: event.threadTs ?? event.messageTs,
    text,
    clientMessageId: await slackClientMessageId(replyKey),
    now: receivedAt,
  });
  if (!posted.ok) {
    traceWarn("integration_gateway.supplier_payout_reply_unavailable", {
      requestId,
      channel_id: event.channelId,
      detail: posted.error.code,
    });
  }
  return { ok: true, value: { mode: "supplier_payout_answered" } };
}

/**
 * Accept a message the Worker decided. It activates the Connector when the
 * published placement has none yet.
 */
export async function acceptSlackCaseCandidate(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  ingress: SlackCaseIngress,
  payoutQuery: SupplierPayoutQuery | null,
): Promise<Result<SlackDurableAccept, SlackDurableAcceptError>> {
  const admission = ingress.admission;
  if (admission.kind !== "authorized")
    return unadmittedSlackDurableAccept(admission);
  const command = buildAdmittedSlackCaseCommand({
    requestId,
    receivedAt,
    event,
    ingress: admission.value,
  });
  if (command === null) {
    return {
      ok: true,
      value: { mode: "rejected", reason: "command_not_permitted" },
    };
  }
  // A supplier-payout read is answered here rather than routed to the Case,
  // and only after the same admission every Case message passes: the requester
  // is a linked member of this organisation, the conversation is one Pantry accepts
  // commands from, and the channel is a registered destination. Answering
  // before any of those would disclose a merchant's outgoing payments to
  // whoever could type the question.
  if (payoutQuery !== null) {
    return answerSupplierPayoutQuery(
      env,
      event,
      admission.value,
      command,
      ingress.slackCredential,
      payoutQuery,
      requestId,
      receivedAt,
    );
  }
  if (admission.value.authority === "rollback_open") {
    // The Connector resolution below repeats this placement check for every
    // message. Only the rollback transition needs the database here.
    const execution = await OrganisationExecutionScope.resolveAtPlacement(
      env,
      admission.value.organisationId,
      admission.value.placement,
    );
    if (!execution.ok) {
      return {
        ok: false,
        error: {
          code: "slack_event_not_durable",
          detail: execution.error.code,
        },
      };
    }
    const transitioned = await authorizeCloudflareAuthoritativeMutation({
      db: execution.value.database,
      organisationId: admission.value.organisationId,
      occurredAt: receivedAt,
    });
    if (!transitioned.ok) {
      return {
        ok: false,
        error: {
          code: "slack_event_not_durable",
          detail: transitioned.error.code,
        },
      };
    }
  }
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: env,
    namespace: env.CONNECTOR,
    organisationId: admission.value.organisationId,
    connectorId: admission.value.connectorId,
    placement: admission.value.placement,
    now: receivedAt,
  });
  if (!connector.ok) {
    return {
      ok: false,
      error: { code: "slack_event_not_durable", detail: connector.error.code },
    };
  }
  const accepted = await connector.value.acceptCaseWork({
    identity: {
      organisationId: admission.value.organisationId,
      connectorId: admission.value.connectorId,
    },
    command,
  });
  if (!accepted.ok) {
    return {
      ok: false,
      error: { code: "slack_event_not_durable", detail: accepted.error.code },
    };
  }
  traceLog("integration_gateway.slack.case_accepted", {
    requestId,
    organisation_id: admission.value.organisationId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    event_id: event.eventId,
    case_id: admission.value.caseId,
    disposition: accepted.value.kind,
    admitted_by: "worker",
    elapsed_ms: Date.now() - receivedAt,
  });
  return { ok: true, value: { mode: "case_accepted" } };
}

export function shouldShowSlackIngressProgress(event: SlackMessageEvent): boolean {
  return (
    isSlackCaseRoutingCandidate(event) &&
    !isSlackStopCommand({
      trigger: event.trigger,
      text: slackAuthoredText(event.authored),
    })
  );
}

export async function showSlackIngressProgress(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
  preparation: SlackEventAdmissionPreparation,
): Promise<void> {
  if (preparation.kind !== "case_candidate") {
    traceWarn("integration_gateway.slack_progress_unavailable", {
      requestId,
      channel_id: event.channelId,
      elapsed_ms: Date.now() - receivedAt,
      detail: "slack_case_admission_missing",
    });
    return;
  }
  const admissionStartedAt = Date.now();
  const ingress = await preparation.ingress;
  const admission = ingress.admission;
  if (admission.kind === "identity_link_required") {
    await showSlackIdentityLinkPrompt(
      env,
      event,
      requestId,
      admission.value,
      ingress.slackCredential,
    );
    return;
  }
  if (
    admission.kind === "rejected" &&
    admission.reason === "destination_missing"
  ) {
    await showSlackRoutingSetupPrompt(env, event, requestId);
    return;
  }
  if (
    admission.kind === "rejected" &&
    admission.reason === "command_not_permitted"
  ) {
    // A plain reply can be talk between people, so only a mention gets an
    // answer.
    if (event.trigger === "mention")
      await showSlackCommandRefusal(event, requestId, ingress.slackCredential);
    return;
  }
  const slackCredential =
    admission.kind === "authorized" ? await ingress.slackCredential : null;
  const credentialResolvedAt = Date.now();
  if (slackCredential === null || slackCredential.kind !== "ready") {
    traceWarn("integration_gateway.slack_progress_unavailable", {
      requestId,
      channel_id: event.channelId,
      elapsed_ms: credentialResolvedAt - receivedAt,
      admission_elapsed_ms: credentialResolvedAt - admissionStartedAt,
      detail: slackIngressProgressFailureDetail(admission, slackCredential),
    });
    return;
  }
  const status = await setSlackThreadStatus({
    token: slackCredential.token,
    channelId: event.channelId,
    threadTs: event.threadTs,
    status: "is thinking…",
  });
  const elapsedMs = Date.now() - receivedAt;
  if (!status.ok) {
    traceWarn("integration_gateway.slack_progress_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      elapsed_ms: elapsedMs,
      admission_elapsed_ms: credentialResolvedAt - admissionStartedAt,
      slack_api_elapsed_ms: Date.now() - credentialResolvedAt,
      detail: status.error.detail,
    });
    return;
  }
  traceLog("integration_gateway.slack_progress_visible", {
    requestId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    elapsed_ms: elapsedMs,
    admission_elapsed_ms: credentialResolvedAt - admissionStartedAt,
    slack_api_elapsed_ms: Date.now() - credentialResolvedAt,
  });
}

export async function showSlackRoutingSetupPrompt(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
): Promise<void> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.SATYR_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) return;
  const credential = await resolveActiveSlackPhysicalInstallationCredential({
    env,
    keys: env,
    installationIdentity: installationIdentity.value,
    workspaceId: event.workspaceId,
  });
  if (!credential.ok || credential.value.kind !== "bearer") return;
  const directMessage = event.channelId.startsWith("D");
  const text = directMessage
    ? "Choose an organisation in Seams Pantry before starting a Case in this DM."
    : "This channel is not assigned to an organisation. Ask an organisation admin to add it in Slack settings.";
  const posted = await postSlackThreadMessage({
    token: credential.value.value,
    channelId: event.channelId,
    threadTs: event.threadTs,
    text,
    clientMessageId: await slackClientMessageId(
      `slack-routing-setup:${event.eventId}`,
    ),
    now: Date.now(),
  });
  if (!posted.ok) {
    traceWarn("integration_gateway.slack_routing_setup_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      detail: posted.error.code,
    });
  }
}

/** Tell one person, and nobody else, why the agent did not take the message. */
export async function showSlackCommandRefusal(
  event: SlackMessageEvent,
  requestId: RequestId,
  pendingCredential: PendingSlackIngressCredential | null,
): Promise<void> {
  const slackCredential = await pendingCredential;
  const posted =
    slackCredential === null || slackCredential.kind !== "ready"
      ? {
          ok: false as const,
          error: slackCredential?.reason ?? "slack_credential_unavailable",
        }
      : await postSlackEphemeralMessage({
          token: slackCredential.token,
          channelId: event.channelId,
          externalUserId: event.author,
          threadTs: event.messageTs === event.threadTs ? null : event.threadTs,
          text: "Your role in this organisation can view work but not ask the agent to do it. An owner or admin can change your role.",
        });
  if (!posted.ok) {
    traceWarn("integration_gateway.slack_command_refusal_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      external_user_id: event.author,
      detail: posted.error,
    });
  }
}

export async function showSlackIdentityLinkPrompt(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  required: Variant<
    SlackCaseIngressAdmission,
    "identity_link_required"
  >["value"],
  pendingCredential: PendingSlackIngressCredential | null,
): Promise<void> {
  const slackCredential = await pendingCredential;
  if (slackCredential === null || slackCredential.kind !== "ready") {
    traceWarn("integration_gateway.slack_identity_link_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      external_user_id: event.author,
      detail: slackCredential?.reason ?? "slack_credential_unavailable",
    });
    return;
  }
  const now = Date.now();
  const issued = await issueIdentityLink({
    env,
    organisationId: required.organisationId,
    workspaceId: required.workspaceId,
    externalUserId: required.externalUserId,
    source: { kind: "slack_event", eventId: event.eventId },
    now,
    expiresAt: now + 10 * 60 * 1000,
  });
  if (!issued.ok) {
    traceWarn("integration_gateway.slack_identity_link_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      external_user_id: event.author,
      detail: issued.error.code,
    });
    return;
  }
  const browserUrl = identityLinkBrowserUrl(env, issued.value.token);
  const posted = await postSlackEphemeralMessage({
    token: slackCredential.token,
    channelId: event.channelId,
    externalUserId: event.author,
    threadTs: null,
    text: `Link your Slack identity to Seams Pantry: ${browserUrl}`,
  });
  if (!posted.ok) {
    traceWarn("integration_gateway.slack_identity_link_unavailable", {
      requestId,
      workspace_id: event.workspaceId,
      channel_id: event.channelId,
      external_user_id: event.author,
      detail: posted.error,
    });
    return;
  }
  traceLog("integration_gateway.slack_identity_link_prompted", {
    requestId,
    organisation_id: required.organisationId,
    workspace_id: event.workspaceId,
    channel_id: event.channelId,
    external_user_id: event.author,
    challenge_id: issued.value.challengeId,
  });
}

export async function postSlackEphemeralMessage(input: {
  readonly token: string;
  readonly channelId: SlackMessageEvent["channelId"];
  readonly externalUserId: SlackMessageEvent["author"];
  readonly threadTs: string | null;
  readonly text: string;
}): Promise<Result<null, string>> {
  try {
    const response = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channelId,
        user: input.externalUserId,
        text: input.text,
        ...(input.threadTs === null ? {} : { thread_ts: input.threadTs }),
      }),
    });
    const body: unknown = await response.json();
    if (isRecord(body) && body.ok === true) {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      error:
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `slack_http_${response.status}`,
    };
  } catch {
    return { ok: false, error: "slack_ephemeral_message_failed" };
  }
}

export function slackIngressProgressFailureDetail(
  admission: Variant<
    SlackCaseIngressAdmissionView,
    "authorized" | "rejected" | "retry"
  >,
  slackCredential: SlackIngressCredential | null,
): string {
  switch (admission.kind) {
    case "authorized":
      return slackCredential?.kind === "unavailable"
        ? slackCredential.reason
        : "slack_credential_ready";
    case "retry":
      return admission.code;
    case "rejected":
      return admission.reason;
    default:
      return assertNever(admission);
  }
}

export type SlackEventAdmissionPreparation =
  | {
      readonly kind: "case_candidate";
      readonly ingress: Promise<SlackCaseIngressFlow>;
    }
  | {
      readonly kind: "standard";
    };

export function prepareSlackEventAdmission(
  env: Env,
  event: SlackMessageEvent,
  requestId: RequestId,
  receivedAt: number,
): SlackEventAdmissionPreparation {
  if (
    isSlackCaseRoutingCandidate(event) &&
    !isSlackStopCommand({
      trigger: event.trigger,
      text: slackAuthoredText(event.authored),
    })
  ) {
    return {
      kind: "case_candidate",
      ingress: resolveSlackCaseIngress(env, event, requestId, receivedAt),
    };
  }
  return { kind: "standard" };
}
