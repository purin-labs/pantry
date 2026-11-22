import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";

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
  const tables = [
    "whatsapp_delivery_status",
    "whatsapp_message_receipt",
    "whatsapp_reply_proposal",
    "whatsapp_case_conversation_window",
    "whatsapp_ingress_policy_revision",
    "whatsapp_ingress_policy",
    "whatsapp_support_binding_revision",
    "whatsapp_support_binding",
    "whatsapp_phone_number_account",
  ] as const;
  return tables.map((table) => {
    // The binding-revision table is keyed by its binding, not by the account.
    const where =
      table === "whatsapp_support_binding_revision" && scope.kind === "account"
        ? `support_binding_id IN (
           SELECT support_binding_id FROM whatsapp_support_binding
           WHERE integration_account_id = ?
         )`
        : `${column} = ?`;
    return session.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(value);
  });
}
