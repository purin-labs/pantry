/**
 * The purge entries of the tables of the Inbox (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const INBOX_PURGE_ENTRIES = [
  {
    order: 80,
    table: "email_thread_case",
    action: "erase",
    statement: "DELETE FROM email_thread_case",
  },
  {
    order: 90,
    table: "agent_mailbox_binding_revision",
    action: "erase",
    statement: "DELETE FROM agent_mailbox_binding_revision",
  },
  {
    order: 140,
    table: "whatsapp_case_conversation_window",
    action: "erase",
    statement: "DELETE FROM whatsapp_case_conversation_window",
  },
  {
    order: 150,
    table: "whatsapp_support_binding_revision",
    action: "erase",
    statement: "DELETE FROM whatsapp_support_binding_revision",
  },
  {
    order: 190,
    table: "agent_mailbox_binding",
    action: "erase",
    statement: "DELETE FROM agent_mailbox_binding",
  },
  {
    order: 450,
    table: "contact_endpoint_verification",
    action: "erase",
    statement: "DELETE FROM contact_endpoint_verification",
  },
  {
    order: 580,
    table: "email_message_receipt",
    action: "erase",
    statement: "DELETE FROM email_message_receipt",
  },
  {
    order: 590,
    table: "email_reply_proposal",
    action: "erase",
    statement: "DELETE FROM email_reply_proposal",
  },
  {
    order: 600,
    table: "mailbox_ingress_policy",
    action: "erase",
    statement: "DELETE FROM mailbox_ingress_policy",
  },
  {
    order: 610,
    table: "mailbox_ingress_policy_revision",
    action: "erase",
    statement: "DELETE FROM mailbox_ingress_policy_revision",
  },
  {
    order: 620,
    table: "email_mailbox_account",
    action: "pseudonymize",
    reason:
      "The Google account gives up its subject and its address, so that a new Organisation can connect it.",
  },
  {
    order: 630,
    table: "email_operational_attestation",
    action: "erase",
    statement: "DELETE FROM email_operational_attestation",
  },
  {
    order: 640,
    table: "email_operational_proposal_projection",
    action: "erase",
    statement: "DELETE FROM email_operational_proposal_projection",
  },
  {
    order: 650,
    table: "email_self_test",
    action: "erase",
    statement: "DELETE FROM email_self_test",
  },
  {
    order: 660,
    table: "email_sender_account",
    action: "pseudonymize",
    reason:
      "The Google account gives up its subject and its address, so that a new Organisation can connect it.",
  },
  {
    order: 700,
    table: "mail_assistant_eligibility",
    action: "erase",
    statement: "DELETE FROM mail_assistant_eligibility",
  },
  {
    order: 710,
    table: "mail_classification",
    action: "erase",
    statement: "DELETE FROM mail_classification",
  },
  {
    order: 930,
    table: "whatsapp_delivery_status",
    action: "erase",
    statement: "DELETE FROM whatsapp_delivery_status",
  },
  {
    order: 940,
    table: "whatsapp_ingress_policy",
    action: "erase",
    statement: "DELETE FROM whatsapp_ingress_policy",
  },
  {
    order: 950,
    table: "whatsapp_ingress_policy_revision",
    action: "erase",
    statement: "DELETE FROM whatsapp_ingress_policy_revision",
  },
  {
    order: 960,
    table: "whatsapp_message_receipt",
    action: "erase",
    statement: "DELETE FROM whatsapp_message_receipt",
  },
  {
    order: 970,
    table: "whatsapp_reply_proposal",
    action: "erase",
    statement: "DELETE FROM whatsapp_reply_proposal",
  },
  {
    order: 980,
    table: "whatsapp_support_binding",
    action: "erase",
    statement: "DELETE FROM whatsapp_support_binding",
  },
  {
    order: 990,
    table: "whatsapp_phone_number_account",
    action: "erase",
    statement: "DELETE FROM whatsapp_phone_number_account",
  },
  {
    order: 1160,
    table: "email_operational_contact",
    action: "erase",
    statement: "DELETE FROM email_operational_contact",
  },
  {
    order: 1180,
    table: "gmail_inference_eligibility",
    action: "erase",
    statement: "DELETE FROM gmail_inference_eligibility",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
