import type { SqlStorage } from "@cloudflare/workers-types";
import type { MailboxSetupModel } from "@purin-labs/control-api";
import { deliverOperationsCard } from "@purin-labs/actor-runtime/actors/operations-channel";
import type { Env } from "@purin-labs/kernel/env";
import { parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { sha256Hex } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import {
  readOperationsDestination,
  type OperationsDestination,
} from "@purin-labs/tenancy/data/operations-destination";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readEmailMailboxAccount } from "../data/email-mailbox";
import {
  mailModelNoticeDeliveryId,
  mailModelNoticeUpdateDeliveryId,
} from "./contract/mail-model-notice-delivery";
import { readGmailModelState } from "./gmail-model-consent";

/**
 * New mail goes only to a model whose data terms an owner or admin accepted
 * (Google's Limited Use rules, INB-01). When the model changes or Purin's
 * review of it ends, new mail waits. The mailbox's Inbox says so, and one
 * card in the operations channel tells the shop at the first reply turn that
 * waits. Each mailbox gets one card for each wait: a new model, or a new
 * review of the same model, is a new wait. When mail may go to the model
 * again, the same card says so. The card holds no mail content.
 */

/** The Connector's record of the waits that it told the channel about. */
export function createMailModelNoticeSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_model_notice (
    delivery_id TEXT PRIMARY KEY,
    noticed_at INTEGER NOT NULL,
    card_sent INTEGER NOT NULL CHECK (card_sent IN (0, 1)),
    settled_at INTEGER
  )`);
}

type NoticeInput = Readonly<{
  sql: SqlStorage;
  integrationAccountId: string;
  now: number;
}>;

/**
 * Tells the operations channel that new mail of this mailbox waits for its
 * model, unless it already did for this wait. A shop with no Slack channel
 * sees the wait in Inbox only. A card that did not go out is tried again at
 * the next reply turn that waits.
 */
export async function noticeMailModelWait(
  env: Env,
  scope: OrganisationExecutionScope,
  input: NoticeInput,
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
      markNoticed(input.sql, deliveryId, input.now, false);
    return;
  }
  const address = await mailboxAddress(scope, account.value);
  if (address === null) return;
  const sent = await deliverCard(env, scope, destination.value, {
    noticeDeliveryId: deliveryId,
    deliveryId,
    revision: 1,
    text: mailModelWaitText(address, model),
    now: input.now,
  });
  if (sent) markNoticed(input.sql, deliveryId, input.now, true);
}

/**
 * Says on each open card of this mailbox that mail goes to the model again,
 * once an owner or admin accepted its terms. A card whose change did not go
 * out is tried again at the next call. A shop that removed its channel has
 * no card to change.
 */
export async function settleMailModelNotices(
  env: Env,
  scope: OrganisationExecutionScope,
  input: NoticeInput,
): Promise<void> {
  const open = input.sql
    .exec<{ delivery_id: string }>(
      `SELECT delivery_id FROM connector_email_model_notice
       WHERE card_sent = 1 AND settled_at IS NULL ORDER BY noticed_at`,
    )
    .toArray();
  if (open.length === 0) return;
  const account = parseIntegrationAccountId(input.integrationAccountId);
  if (!account.ok) return;
  const model = await readGmailModelState({ env, scope, now: input.now });
  if (model.kind !== "approved") return;
  const destination = await readOperationsDestination(
    scope.database,
    scope.organisationId,
  );
  if (!destination.ok) {
    if (destination.error === "operations_destination_missing")
      for (const row of open) settle(input.sql, row.delivery_id, input.now);
    return;
  }
  const address = await mailboxAddress(scope, account.value);
  if (address === null) return;
  for (const row of open) {
    const sent = await deliverCard(env, scope, destination.value, {
      noticeDeliveryId: row.delivery_id,
      deliveryId: mailModelNoticeUpdateDeliveryId(row.delivery_id),
      revision: 2,
      text: `Mail to ${address} gets agent replies again. The data terms of ${model.review.name} are accepted.`,
      now: input.now,
    });
    if (sent) settle(input.sql, row.delivery_id, input.now);
  }
}

type WaitingModel = Variant<
  MailboxSetupModel,
  "consent_needed" | "not_reviewed"
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

async function mailboxAddress(
  scope: OrganisationExecutionScope,
  integrationAccountId: Parameters<
    typeof readEmailMailboxAccount
  >[0]["integrationAccountId"],
): Promise<string | null> {
  const mailbox = await readEmailMailboxAccount({
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId,
  });
  return mailbox.ok ? mailbox.value.observedAddress : null;
}

/**
 * One card and its change share the identity that the notice's delivery id
 * names. True when the card went out.
 */
async function deliverCard(
  env: Env,
  scope: OrganisationExecutionScope,
  destination: OperationsDestination,
  card: Readonly<{
    noticeDeliveryId: string;
    deliveryId: string;
    revision: number;
    text: string;
    now: number;
  }>,
): Promise<boolean> {
  const id = (await sha256Hex(card.noticeDeliveryId)).slice(0, 24);
  const ts = await deliverOperationsCard(
    env,
    scope,
    destination,
    {
      deliveryId: card.deliveryId,
      bindingId: `mail_model_binding_${id}`,
      caseId: `mail_model_case_${id}`,
      caseRevision: card.revision,
      text: card.text,
      idempotencyKey: `mail_model:${card.deliveryId}`,
      trace: "inbox.mail_model_notice",
    },
    card.now,
  );
  return ts !== null;
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

function markNoticed(
  sql: SqlStorage,
  deliveryId: string,
  now: number,
  cardSent: boolean,
): void {
  sql.exec(
    `INSERT INTO connector_email_model_notice (
       delivery_id, noticed_at, card_sent, settled_at
     ) VALUES (?, ?, ?, NULL) ON CONFLICT (delivery_id) DO NOTHING`,
    deliveryId,
    now,
    cardSent ? 1 : 0,
  );
}

function settle(sql: SqlStorage, deliveryId: string, now: number): void {
  sql.exec(
    "UPDATE connector_email_model_notice SET settled_at = ? WHERE delivery_id = ? AND settled_at IS NULL",
    now,
    deliveryId,
  );
}
