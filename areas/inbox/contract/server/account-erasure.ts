import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationPurgeContext } from "@purin-labs/tenancy/data/organisation-lifecycle-port";

/** The verified contacts of one removed account. */
export function prepareAccountContactVerificationsDelete(
  session: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): D1PreparedStatement {
  return session
    .prepare(
      "DELETE FROM contact_endpoint_verification WHERE organisation_id = ? AND integration_account_id = ?",
    )
    .bind(organisationId, integrationAccountId);
}

/** The purge rewrite of the Organisation's mailbox accounts. */
export function prepareOrganisationPurgeMailboxAccounts(
  context: OrganisationPurgeContext,
): readonly D1PreparedStatement[] {
  return [googleAccountRelease(context, "UPDATE email_mailbox_account")];
}

/** The purge rewrite of the Organisation's sender accounts. */
export function prepareOrganisationPurgeSenderAccounts(
  context: OrganisationPurgeContext,
): readonly D1PreparedStatement[] {
  return [googleAccountRelease(context, "UPDATE email_sender_account")];
}

/**
 * A Google account can belong to one Organisation at a time. The purge gives
 * it up, and the erased address stays a valid value.
 */
function googleAccountRelease(
  context: OrganisationPurgeContext,
  update: "UPDATE email_mailbox_account" | "UPDATE email_sender_account",
): D1PreparedStatement {
  return context.session
    .prepare(
      `${update}
       SET google_subject = 'archived:' || integration_account_id,
           observed_address = integration_account_id || '@archived.invalid'
       WHERE organisation_id = ? AND ${context.purged.sql}`,
    )
    .bind(context.organisationId, ...context.purged.bindings);
}

export function whatsappErasureStatements(
  session: Pick<OrganisationDatabaseSession, "prepare">,
  scope:
    | {
        readonly kind: "account";
        readonly integrationAccountId: IntegrationAccountId;
      }
    | {
        readonly kind: "organisation";
        readonly organisationId: OrganisationId;
      },
): readonly D1PreparedStatement[] {
  const column =
    scope.kind === "account" ? "integration_account_id" : "organisation_id";
  const value =
    scope.kind === "account"
      ? scope.integrationAccountId
      : scope.organisationId;
  const where = `${column} = ?`;
  // The binding-revision table is keyed by its binding, not by the account.
  const bindingRevisionWhere =
    scope.kind === "account"
      ? `support_binding_id IN (
           SELECT support_binding_id FROM whatsapp_support_binding
           WHERE integration_account_id = ?
         )`
      : where;
  return [
    `DELETE FROM whatsapp_delivery_status WHERE ${where}`,
    `DELETE FROM whatsapp_message_receipt WHERE ${where}`,
    `DELETE FROM whatsapp_reply_proposal WHERE ${where}`,
    `DELETE FROM whatsapp_case_conversation_window WHERE ${where}`,
    `DELETE FROM whatsapp_ingress_policy_revision WHERE ${where}`,
    `DELETE FROM whatsapp_ingress_policy WHERE ${where}`,
    `DELETE FROM whatsapp_support_binding_revision WHERE ${bindingRevisionWhere}`,
    `DELETE FROM whatsapp_support_binding WHERE ${where}`,
    `DELETE FROM whatsapp_phone_number_account WHERE ${where}`,
  ].map((sql) => session.prepare(sql).bind(value));
}
