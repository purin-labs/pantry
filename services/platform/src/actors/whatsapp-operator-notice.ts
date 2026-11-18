import { SLACK_NO_LINK_PREVIEW } from "../slack/messages";
import { isRecord } from "@seams/std";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { isActorExecutionActive } from "./actor-execution-quiescence";
import type { SqlStorage } from "@cloudflare/workers-types";

import { resolveActiveSlackOrganisationCredential } from "../credential-vault";
import type { Env } from "../env";
import { parseChannelId, parseWorkspaceId } from "../ids";
import type { Result } from "../result";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import { resolveActiveSlackDestinationConnection } from "../slack/organisation-routing";
import {
  markWhatsAppNoticeDelivered,
  readWhatsAppOperatorNotice,
  type WhatsAppPauseReason,
} from "./connector-whatsapp";

/**
 * The notify half of `pause_and_notify`. When an account stops taking agent
 * work, one operator notice goes to the organisation's already-selected
 * communication destination. Deduplication happens at the pause receipt, so a
 * burst that trips the same limit repeatedly produces one notice, not one per
 * message.
 *
 * The notice is content-free by construction: it names the account, the
 * reason, and the observed counters. Customer text and proposal bodies are
 * never assembled here, so a notice cannot become a second copy of a message.
 */

export type WhatsAppNoticeOutcome =
  | { readonly kind: "delivered"; readonly channelId: string }
  | { readonly kind: "suppressed"; readonly reason: "already_notified" }
  | { readonly kind: "undeliverable"; readonly reason: string };

export type WhatsAppNoticeError = { readonly code: string };

type CommunicationDestination = {
  readonly workspaceId: string;
  readonly channelId: string;
};

export async function deliverWhatsAppOperatorNotice(
  input: Readonly<{
    env: Env;
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    displayPhoneNumber: string;
    noticeKey: string;
    now: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<WhatsAppNoticeOutcome, WhatsAppNoticeError>> {
  if (!(await isActorExecutionActive(input.sql, input.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const notice = readWhatsAppOperatorNotice(input.sql, input.noticeKey);
  if (notice === null)
    return { ok: false, error: { code: "whatsapp_notice_missing" } };
  if (notice.deliveredAt !== null) {
    return {
      ok: true,
      value: { kind: "suppressed", reason: "already_notified" },
    };
  }
  const destination = await readCommunicationDestination(input.scope);
  if (destination === null) {
    return {
      ok: true,
      value: { kind: "undeliverable", reason: "destination_unselected" },
    };
  }
  const workspaceId = parseWorkspaceId(destination.workspaceId);
  const channelId = parseChannelId(destination.channelId);
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: input.env.SATYR_DEPLOYMENT_PROFILE,
    appId: input.env.SLACK_APP_ID,
  });
  if (!workspaceId.ok || !channelId.ok || !installationIdentity.ok) {
    return {
      ok: true,
      value: { kind: "undeliverable", reason: "destination_invalid" },
    };
  }
  const connection = await resolveActiveSlackDestinationConnection(input.env, {
    environment: installationIdentity.value.environment,
    appId: installationIdentity.value.appId,
    organisationId: input.scope.organisationId,
    workspaceId: workspaceId.value,
    channelId: channelId.value,
  });
  if (!connection.ok) {
    return {
      ok: true,
      value: {
        kind: "undeliverable",
        reason: "destination_credential_unavailable",
      },
    };
  }
  const token = await resolveActiveSlackOrganisationCredential({
    env: input.env,
    keys: input.env,
    installationIdentity: installationIdentity.value,
    organisationId: input.scope.organisationId,
    integrationAccountId: connection.value.integrationAccountId,
    workspaceId: workspaceId.value,
  });
  if (!token.ok || token.value.kind !== "bearer") {
    return {
      ok: true,
      value: {
        kind: "undeliverable",
        reason: "destination_credential_unavailable",
      },
    };
  }
  if (!(await isActorExecutionActive(input.sql, input.scope))) {
    return { ok: false, error: { code: "connector_placement_conflict" } };
  }
  const posted = await postSlackNotice({
    token: token.value.value,
    channelId: destination.channelId,
    text: renderOperatorNotice(input.displayPhoneNumber, notice.reason),
    fetcher: input.fetcher,
  });
  if (!posted) {
    return {
      ok: true,
      value: { kind: "undeliverable", reason: "destination_unreachable" },
    };
  }
  markWhatsAppNoticeDelivered(input.sql, input.noticeKey, input.now);
  return {
    ok: true,
    value: { kind: "delivered", channelId: destination.channelId },
  };
}

/**
 * Operator-facing copy. It states what stopped, why, and what to do — and
 * never quotes the customer.
 */
export function renderOperatorNotice(
  displayPhoneNumber: string,
  reason: WhatsAppPauseReason,
): string {
  const head = `WhatsApp support paused for ${displayPhoneNumber}.`;
  const tail =
    "New customer messages are not being processed. Resume it from the WhatsApp integration page once you have dealt with the cause.";
  switch (reason.kind) {
    case "active_case_limit":
      return `${head} ${reason.observed} open Cases reached the published limit of ${reason.limit}. ${tail}`;
    case "hourly_message_limit":
      return `${head} ${reason.observed} messages this hour reached the published limit of ${reason.limit}. ${tail}`;
    case "daily_token_budget":
      return `${head} The daily agent token budget of ${reason.limit} is exhausted. ${tail}`;
    case "message_too_large":
      return `${head} A message exceeded the published size limit of ${reason.limitBytes} bytes. Skip that message or raise the limit. ${tail}`;
    case "unsupported_message_type":
      return `${head} A customer sent a ${reason.messageType} message, which this integration does not handle. Reply in WhatsApp yourself, then skip that message. ${tail}`;
    case "service_window_expired":
      return `WhatsApp support on ${displayPhoneNumber}: a proposed reply passed WhatsApp's 24-hour service window before it was approved. Seams Pantry deleted the draft and did not contact the customer. Reply in WhatsApp yourself if the customer still needs an answer.`;
    case "send_indeterminate":
      return `${head} WhatsApp did not confirm whether an approved reply was delivered. Seams Pantry will not retry it: check WhatsApp and record what you find. ${tail}`;
  }
}

async function readCommunicationDestination(
  scope: OrganisationExecutionScope,
): Promise<CommunicationDestination | null> {
  const row = await scope.database
    .prepare(
      `SELECT workspace_id AS workspaceId, channel_id AS channelId
       FROM organisation_communication_destination WHERE organisation_id = ?`,
    )
    .bind(scope.organisationId)
    .first<{ readonly workspaceId: unknown; readonly channelId: unknown }>();
  return row !== null &&
    typeof row.workspaceId === "string" &&
    typeof row.channelId === "string"
    ? { workspaceId: row.workspaceId, channelId: row.channelId }
    : null;
}

async function postSlackNotice(
  input: Readonly<{
    token: string;
    channelId: string;
    text: string;
    fetcher: typeof fetch;
  }>,
): Promise<boolean> {
  try {
    const response = await input.fetcher(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: input.channelId,
          text: input.text,
          ...SLACK_NO_LINK_PREVIEW,
        }),
      },
    );
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body) && body.ok === true;
  } catch {
    return false;
  }
}
