import { SLACK_STREAM_TEXT_LIMIT } from "../../slack/stream";
import type { ConnectorDelivery } from "@purin-labs/contracts";
import type { Env } from "../../env";
import {
  readSlackThreadCredentialRoute,
  resolveActiveSlackOrganisationCredential,
  resolveRoutedSlackThreadCredential,
  slackThreadCredentialIsAtScope,
} from "../../credential-vault";
import {
  newRequestId,
  parseChannelId,
  parseOrganisationId,
  type OrganisationId,
  parseWorkspaceId,
} from "../../ids";
import { traceLog } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { resolveConfiguredSlackInstallationIdentity } from "../../slack/installation-identity";
import {
  commerceActionPortalUrl,
  commerceCardBlocks,
} from "../../slack/commerce-approval-card";
import {
  commerceApprovalNoticeDeliveryId,
  commerceApprovalNoticeNonce,
  commerceOutcomeNonce,
} from "../case/commerce-delivery-ids";
import { readOrganisationDefaultWorkspacePortalAddress } from "../../data/organisation-workspace";
import {
  permissionCardBlocks,
  permissionDecidedCardBlocks,
  permissionDecisionRequestId,
  permissionNoticeDeliveryId,
  permissionNoticeRequestId,
  permissionRequestPortalUrl,
} from "../../slack/permission-request-notice";
import {
  aiBudgetPortalUrl,
  budgetCardBlocks,
  isBudgetNoticeDelivery,
} from "../../slack/budget-notice";
import {
  heldCardBlocks,
  heldNoticeOfDecision,
  heldNoticeRequestId,
  heldOutputPortalUrl,
} from "../../slack/held-output-notice";
import { noticeCardBlocks } from "../../slack/notice-card";
import {
  deviceAlertCardBlocks,
  devicesPortalUrl,
} from "../../slack/device-alert-card";
import {
  deviceAlertNoticeOfUpdate,
  isDeviceAlertDelivery,
} from "../../devices/contract/alert-delivery";
import { slackMayApproveAction } from "../../commerce/action-model";
import { resolveActiveSlackDestinationConnection } from "../../slack/installation-store";
import { requireActiveOrganisationActor } from "../actor-router";
import { checkPreparedConnectorDelivery } from "../connector-slack-stream";
import {
  isAmbiguousSlackOutcome,
  slackClientMessageId,
  slackRetryAt,
  SLACK_NO_LINK_PREVIEW,
} from "../../slack/messages";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isNonBlankString, isRecord } from "@purin-labs/std";
import { parseDeliveryState } from "./ingress-parsers";
import {
  type ConnectorDeliveryRequest,
  type ConnectorDeliveryResult,
  DELIVERY_RETRY_MS,
} from "./types";

type SlackDeliveryResponse =
  | { readonly kind: "delivered"; readonly timestamp: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "invalid" };

/**
 * Start the read of the route of a Slack thread delivery's bot credential.
 * Null when the delivery does not address a Slack thread or its address
 * does not parse. The delivery then decides that itself.
 */
export function startSlackThreadCredentialRoute(
  env: Env,
  input: ConnectorDeliveryRequest,
): ReturnType<typeof readSlackThreadCredentialRoute> | null {
  const address = input.delivery.address;
  if (address.kind !== "slack") return null;
  const organisationId = parseOrganisationId(input.identity.organisationId);
  const workspaceId = parseWorkspaceId(address.workspaceId);
  const channelId = parseChannelId(address.channelId);
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (
    !organisationId.ok ||
    !workspaceId.ok ||
    !channelId.ok ||
    !installationIdentity.ok
  )
    return null;
  return readSlackThreadCredentialRoute({
    env,
    installationIdentity: installationIdentity.value,
    organisationId: organisationId.value,
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    rootMessageTs: address.threadTs,
  });
}

export async function deliverSlackOutput(
  env: Env,
  sql: SqlStorage,
  input: ConnectorDeliveryRequest,
  scope: OrganisationExecutionScope,
  startedRoute: ReturnType<typeof readSlackThreadCredentialRoute> | null,
): Promise<ConnectorDeliveryResult> {
  const address = input.delivery.address;
  if (address.kind === "email_thread") {
    return {
      kind: "rejected",
      reason: "connector_email_delivery_not_implemented",
    };
  }
  if (address.kind === "whatsapp_conversation") {
    // WhatsApp replies leave through the approved-proposal send ladder, never
    // through the generic Case outbox delivery path.
    return {
      kind: "rejected",
      reason: "connector_whatsapp_delivery_not_supported",
    };
  }
  const organisationId = parseOrganisationId(input.identity.organisationId);
  const workspaceId = parseWorkspaceId(address.workspaceId);
  const channelId = parseChannelId(address.channelId);
  if (!organisationId.ok || !workspaceId.ok || !channelId.ok)
    return { kind: "rejected", reason: "connector_address_invalid" };
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  // The post needs this digest of the delivery's key. It is computed before
  // the last reads, so the post follows them at once.
  const clientMessageId = await slackClientMessageId(
    input.delivery.idempotencyKey,
  );
  const preparedCheck = {
    sql,
    scope,
    identity: input.identity,
    delivery: input.delivery,
    requestedAt: input.requestedAt,
  };
  let token;
  let prepared: Awaited<
    ReturnType<typeof checkPreparedConnectorDelivery>
  > | null = null;
  if (address.kind === "slack") {
    if (!installationIdentity.ok) {
      return { kind: "rejected", reason: installationIdentity.error.code };
    }
    const route = await (startedRoute ??
      readSlackThreadCredentialRoute({
        env,
        installationIdentity: installationIdentity.value,
        organisationId: organisationId.value,
        workspaceId: workspaceId.value,
        channelId: channelId.value,
        rootMessageTs: address.threadTs,
      }));
    if (!route.ok) {
      return {
        kind: "retry",
        reason: "connector_credential_unavailable",
        retryAt: input.requestedAt + DELIVERY_RETRY_MS,
      };
    }
    const credential = resolveRoutedSlackThreadCredential({
      scope,
      env,
      keys: env,
      organisationId: organisationId.value,
      route: route.value,
    });
    if (
      slackThreadCredentialIsAtScope(scope, organisationId.value, route.value)
    ) {
      // The account check and the vault read are the last reads of this
      // post, in the scope's database. The prepared check reads the fence of
      // that database beside them: the three reads start together, and the
      // post waits for nothing after them.
      [token, prepared] = await Promise.all([
        credential,
        checkPreparedConnectorDelivery(preparedCheck),
      ]);
    } else {
      // Another Organisation's placement is read in more than one wait. The
      // fence is read after it.
      token = await credential;
    }
  } else {
    if (!installationIdentity.ok) {
      return { kind: "rejected", reason: installationIdentity.error.code };
    }
    const destination = await resolveActiveSlackDestinationConnection(env, {
      environment: installationIdentity.value.environment,
      appId: installationIdentity.value.appId,
      organisationId: organisationId.value,
      workspaceId: workspaceId.value,
      channelId: channelId.value,
    });
    if (!destination.ok) {
      return {
        kind: "retry",
        reason: "connector_credential_unavailable",
        retryAt: input.requestedAt + DELIVERY_RETRY_MS,
      };
    }
    token = await resolveActiveSlackOrganisationCredential({
      env,
      keys: env,
      installationIdentity: installationIdentity.value,
      organisationId: organisationId.value,
      integrationAccountId: destination.value.integrationAccountId,
      workspaceId: workspaceId.value,
    });
  }
  if (!token.ok || token.value.kind !== "bearer") {
    return {
      kind: "retry",
      reason: "connector_credential_unavailable",
      retryAt: input.requestedAt + DELIVERY_RETRY_MS,
    };
  }
  if (input.delivery.content.kind !== "text")
    return { kind: "rejected", reason: "connector_content_unsupported" };
  // The prepared check reads the fence once and then only this Connector's
  // storage. Where it did not share the wait of the credential's last reads,
  // it follows them here. Nothing is waited for between it and the post.
  const blocks =
    (await commerceCardDeliveryBlocks(
      env,
      scope,
      organisationId.value,
      input.delivery.deliveryId,
      input.delivery.content.text,
    )) ??
    (await permissionCardDeliveryBlocks(
      env,
      scope,
      organisationId.value,
      input.delivery.deliveryId,
      input.delivery.content.text,
    )) ??
    (await noticeCardDeliveryBlocks(
      env,
      scope,
      organisationId.value,
      input.delivery.deliveryId,
      input.delivery.content.text,
    )) ??
    (await deviceAlertDeliveryBlocks(
      env,
      scope,
      organisationId.value,
      input.delivery.deliveryId,
      input.delivery.content.text,
    ));
  const cardTs = cardMessageTs(sql, input.delivery.deliveryId);
  prepared ??= await checkPreparedConnectorDelivery(preparedCheck);
  if (prepared.kind !== "ready") return prepared;
  const postStartedAt = Date.now();
  try {
    const updated =
      cardTs === null || blocks === null
        ? null
        : await updateCommerceCard(
            token.value.value,
            channelId.value,
            cardTs,
            input.delivery.content.text,
            blocks,
          );
    const response =
      updated ??
      (await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.value.value}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(
          slackPostMessageBody(
            address,
            channelId.value,
            input.delivery.content.text,
            clientMessageId,
            blocks,
          ),
        ),
      }));
    if (response.status === 429) {
      return {
        kind: "retry",
        reason: "slack_http_429",
        retryAt: slackRetryAt(
          response.headers.get("retry-after"),
          input.requestedAt,
          DELIVERY_RETRY_MS,
        ),
      };
    }
    if (response.status >= 500) {
      return {
        kind: "retry",
        reason: `slack_http_${response.status}`,
        retryAt: input.requestedAt + DELIVERY_RETRY_MS,
      };
    }
    const body = await parseSlackResponse(response);
    traceLog("connector.slack_message_post_completed", {
      requestId: newRequestId(),
      organisation_id: input.identity.organisationId,
      connector_id: input.identity.connectorId,
      case_id: input.delivery.caseId,
      delivery_id: input.delivery.deliveryId,
      outcome: body.kind,
      http_status: response.status,
      duration_ms: Date.now() - postStartedAt,
    });
    switch (body.kind) {
      case "delivered":
        if (!response.ok)
          return { kind: "rejected", reason: `slack_http_${response.status}` };
        return {
          kind: "delivered",
          receipt: {
            deliveryId: input.delivery.deliveryId,
            connectorId: input.identity.connectorId,
            idempotencyKey: input.delivery.idempotencyKey,
            nativeReceiptId: body.timestamp,
            deliveredAt: input.requestedAt,
          },
        };
      case "rejected":
        return response.ok && retryableSlackError(body.reason)
          ? {
              kind: "retry",
              reason: body.reason,
              retryAt: input.requestedAt + DELIVERY_RETRY_MS,
            }
          : { kind: "rejected", reason: body.reason };
      case "invalid":
        return response.ok
          ? {
              kind: "retry",
              reason: "slack_delivery_unavailable",
              retryAt: input.requestedAt + DELIVERY_RETRY_MS,
            }
          : { kind: "rejected", reason: `slack_http_${response.status}` };
      default:
        return assertNever(body);
    }
  } catch {
    return {
      kind: "retry",
      reason: "slack_delivery_unavailable",
      retryAt: input.requestedAt + DELIVERY_RETRY_MS,
    };
  }
}

/**
 * The blocks of a commerce card; null for every other delivery. The delivery
 * identity names the action, and the action's own kind decides. A notice has
 * Approve and Decline when Slack may decide its action, and a Portal link
 * otherwise. A read that fails leaves the buttons out, and the card's text
 * still says where to decide.
 */
async function commerceCardDeliveryBlocks(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  deliveryId: string,
  text: string,
): Promise<readonly Record<string, unknown>[] | null> {
  const noticeNonce = commerceApprovalNoticeNonce(deliveryId);
  const nonce = noticeNonce ?? commerceOutcomeNonce(deliveryId);
  if (nonce === null) return null;
  const portalUrl = await commerceCardPortalUrl(
    env,
    scope,
    organisationId,
    nonce,
  );
  if (noticeNonce === null)
    return commerceCardBlocks(text, {
      kind: "details",
      label: "Details",
      portalUrl,
    });
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    });
    const action = await organisation.getAction({
      organisationId,
      nonce,
      now: Date.now(),
    });
    if (action.ok && slackMayApproveAction(action.value.action))
      return commerceCardBlocks(text, { kind: "decide", nonce, portalUrl });
  } catch {
    // The card keeps its text and its Portal link.
  }
  return commerceCardBlocks(text, {
    kind: "details",
    label: "Review in Portal",
    portalUrl,
  });
}

async function commerceCardPortalUrl(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  nonce: string,
): Promise<string | null> {
  try {
    const address = await readOrganisationDefaultWorkspacePortalAddress({
      db: scope.database,
      organisationId,
    });
    return address.ok
      ? commerceActionPortalUrl(env, address.value, nonce)
      : null;
  } catch {
    return null;
  }
}

/** The blocks of a permission card; null for every other delivery. */
async function permissionCardDeliveryBlocks(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  deliveryId: string,
  text: string,
): Promise<readonly Record<string, unknown>[] | null> {
  if (permissionDecisionRequestId(deliveryId) !== null)
    return permissionDecidedCardBlocks(text);
  const requestId = permissionNoticeRequestId(deliveryId);
  if (requestId === null) return null;
  let portalUrl: string | null = null;
  try {
    const address = await readOrganisationDefaultWorkspacePortalAddress({
      db: scope.database,
      organisationId,
    });
    if (address.ok)
      portalUrl = permissionRequestPortalUrl(env, address.value, requestId);
  } catch {
    // The card keeps its text, which says where to decide.
  }
  return permissionCardBlocks(text, requestId, portalUrl);
}

/** The blocks of a held card or a budget card; null for other deliveries. */
async function noticeCardDeliveryBlocks(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  deliveryId: string,
  text: string,
): Promise<readonly Record<string, unknown>[] | null> {
  if (heldNoticeOfDecision(deliveryId) !== null)
    return noticeCardBlocks(text, null);
  const requestId = heldNoticeRequestId(deliveryId);
  const budget = isBudgetNoticeDelivery(deliveryId);
  if (requestId === null && !budget) return null;
  let address: Readonly<{
    organisationHandle: string;
    workspaceHandle: string;
  }> | null = null;
  try {
    const read = await readOrganisationDefaultWorkspacePortalAddress({
      db: scope.database,
      organisationId,
    });
    if (read.ok) address = read.value;
  } catch {
    // The card keeps its text, which says where to look.
  }
  if (requestId !== null)
    return heldCardBlocks(
      text,
      address === null ? null : heldOutputPortalUrl(env, address, requestId),
    );
  return budgetCardBlocks(
    text,
    address === null ? null : aiBudgetPortalUrl(env, address),
  );
}

async function deviceAlertDeliveryBlocks(
  env: Env,
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  deliveryId: string,
  text: string,
): Promise<readonly Record<string, unknown>[] | null> {
  if (!isDeviceAlertDelivery(deliveryId)) return null;
  try {
    const read = await readOrganisationDefaultWorkspacePortalAddress({
      db: scope.database,
      organisationId,
    });
    return deviceAlertCardBlocks(
      text,
      read.ok ? devicesPortalUrl(env, read.value) : null,
    );
  } catch {
    // The card keeps its text, which says where to look.
    return deviceAlertCardBlocks(text, null);
  }
}

/** The message of the notice that this delivery updates, if any. */
function cardMessageTs(sql: SqlStorage, deliveryId: string): string | null {
  const nonce = commerceOutcomeNonce(deliveryId);
  const requestId = permissionDecisionRequestId(deliveryId);
  const noticeDeliveryId =
    nonce !== null
      ? commerceApprovalNoticeDeliveryId(nonce)
      : requestId !== null
        ? permissionNoticeDeliveryId(requestId)
        : (heldNoticeOfDecision(deliveryId) ??
          deviceAlertNoticeOfUpdate(deliveryId));
  if (noticeDeliveryId === null) return null;
  const row = sql
    .exec<{ state_json: string }>(
      "SELECT state_json FROM connector_delivery WHERE delivery_id = ?",
      noticeDeliveryId,
    )
    .toArray()[0];
  const state = row === undefined ? null : parseDeliveryState(row.state_json);
  return state?.kind === "delivered" ? state.receipt.nativeReceiptId : null;
}

/**
 * Updates a commerce card. Null when the card is gone, for example when a
 * person deleted it, so that the outcome is posted as a new message.
 */
async function updateCommerceCard(
  token: string,
  channelId: string,
  ts: string,
  text: string,
  blocks: readonly Record<string, unknown>[],
): Promise<Response | null> {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, ts, text, blocks }),
  });
  const body = await parseSlackResponse(response.clone());
  return body.kind === "rejected" &&
    (body.reason === "message_not_found" ||
      body.reason === "cant_update_message")
    ? null
    : response;
}

function slackPostMessageBody(
  address: Variant<ConnectorDelivery["address"], "slack" | "slack_channel">,
  channelId: string,
  textValue: string,
  clientMessageId: string,
  blocks: readonly Record<string, unknown>[] | null = null,
): Record<string, unknown> {
  // A streamed answer renders as Markdown, so the posted answer does too.
  // Slack takes at most 12,000 characters of Markdown in one message. A card
  // with blocks keeps its text as the fallback of clients without blocks.
  const common = {
    channel: channelId,
    ...(blocks !== null
      ? { text: textValue, blocks }
      : textValue.length <= SLACK_STREAM_TEXT_LIMIT
        ? { markdown_text: textValue }
        : { text: textValue }),
    client_msg_id: clientMessageId,
    ...SLACK_NO_LINK_PREVIEW,
  };
  switch (address.kind) {
    case "slack":
      return { ...common, thread_ts: address.threadTs };
    case "slack_channel":
      return common;
    default:
      return assertNever(address);
  }
}

async function parseSlackResponse(
  response: Response,
): Promise<SlackDeliveryResponse> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { kind: "invalid" };
  }
  if (isRecord(value)) {
    if (value.ok === true && isNonBlankString(value.ts)) {
      return { kind: "delivered", timestamp: value.ts };
    }
    if (value.ok === false && isNonBlankString(value.error)) {
      return { kind: "rejected", reason: value.error };
    }
  }
  return { kind: "invalid" };
}

/**
 * A post carries `client_msg_id`, so Slack keeps one message for a repeated
 * post: an outcome that may have applied can be posted again, unlike an
 * append to a stream.
 */
function retryableSlackError(reason: string): boolean {
  return (
    isAmbiguousSlackOutcome(reason) ||
    reason === "ratelimited" ||
    reason === "request_timeout"
  );
}
