import type { SqlStorage } from "@cloudflare/workers-types";
import type { MailboxSetupModel } from "@purin-labs/control-api";
import { deliverOperationsCard } from "@purin-labs/actor-runtime/actors/operations-channel";
import type { Env } from "@purin-labs/kernel/env";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { sha256Hex } from "@purin-labs/std";
import { readOperationsDestination } from "@purin-labs/tenancy/data/operations-destination";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readEmailMailboxAccount } from "../data/email-mailbox";
import { mailModelNoticeDeliveryId } from "./contract/mail-model-notice-delivery";
import { readGmailModelState } from "./gmail-model-consent";

/**
 * New mail goes only to a model whose data terms an owner or admin accepted
 * (Google's Limited Use rules, INB-01). When the model changes or Purin's
 * review of it ends, new mail waits. The mailbox's Inbox says so, and one
 * card in the operations channel tells the shop at the first reply turn that
 * waits. Each mailbox gets one card for each wait: a new model, or a new
 * review of the same model, is a new wait. The card holds no mail content.
 */

/** The Connector's record of the waits that it told the channel about. */
export function createMailModelNoticeSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_model_notice (
    delivery_id TEXT PRIMARY KEY,
    noticed_at INTEGER NOT NULL
  )`);
}

/**
 * Tells the operations channel that new mail of this mailbox waits for its
 * model, unless it already did for this wait. A shop with no Slack channel
 * sees the wait in Inbox only. A card that did not go out is tried again at
 * the next reply turn that waits.
 */
export async function noticeMailModelWait(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Readonly<{
    sql: SqlStorage;
    integrationAccountId: string;
    now: number;
  }>,
): Promise<void> {
  const account = parseIntegrationAccountId(input.integrationAccountId);
  if (!account.ok) return;
  const model = await readGmailModelState({ env, scope, now: input.now });
  if (model.kind !== "consent_needed" && model.kind !== "not_reviewed") return;
  const deliveryId = mailModelNoticeDeliveryId(
    account.value,
    (await sha256Hex(waitOf(model))).slice(0, 16),
  );
  if (wasNoticed(input.sql, deliveryId)) return;
  const destination = await readOperationsDestination(
    scope.database,
    scope.organisationId,
  );
  if (!destination.ok) {
    if (destination.error === "operations_destination_missing")
      markNoticed(input.sql, deliveryId, input.now);
    return;
  }
  const mailbox = await readEmailMailboxAccount({
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId: account.value,
  });
  if (!mailbox.ok) return;
  const card = (await sha256Hex(deliveryId)).slice(0, 24);
  const ts = await deliverOperationsCard(
    env,
    scope,
    destination.value,
    {
      deliveryId,
      bindingId: `mail_model_binding_${card}`,
      caseId: `mail_model_case_${card}`,
      caseRevision: 1,
      text: mailModelWaitText(mailbox.value.observedAddress, model),
      idempotencyKey: `mail_model:${deliveryId}`,
      trace: "inbox.mail_model_notice",
    },
    input.now,
  );
  if (ts !== null) markNoticed(input.sql, deliveryId, input.now);
}

type WaitingModel = Extract<
  MailboxSetupModel,
  { kind: "consent_needed" | "not_reviewed" }
>;

function waitOf(model: WaitingModel): string {
  return model.kind === "consent_needed"
    ? `consent:${model.review.keySource}:${model.review.provider}:${model.review.model}:${model.review.reviewExpiresAt}`
    : `not_reviewed:${model.name}`;
}

function mailModelWaitText(address: string, model: WaitingModel): string {
  const late =
    "Mail that waits longer than about 7 hours gets no agent reply and stays in Inbox for a person.";
  return model.kind === "consent_needed"
    ? `New mail to ${address} waits. The AI model for mail is now ${model.review.name}, and an owner or admin must accept its data terms before the agent reads new mail. Until then, the agent writes no replies. ${late}`
    : `New mail to ${address} waits. Purin has not reviewed ${model.name} for email, so the agent reads no new mail with it. An owner or admin can choose another AI model. ${late}`;
}

function wasNoticed(sql: SqlStorage, deliveryId: string): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM connector_email_model_notice WHERE delivery_id = ?",
        deliveryId,
      )
      .toArray().length > 0
  );
}

function markNoticed(sql: SqlStorage, deliveryId: string, now: number): void {
  sql.exec(
    `INSERT INTO connector_email_model_notice (delivery_id, noticed_at)
     VALUES (?, ?) ON CONFLICT (delivery_id) DO NOTHING`,
    deliveryId,
    now,
  );
}
