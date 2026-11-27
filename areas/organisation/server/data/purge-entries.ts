/**
 * The purge entries of the tables of the Organisation area (Refactor 17): what the purge of
 * an archived Organisation does with each one. The Worker joins the entries
 * of each table owner in the order of `order` and gives the list to tenancy
 * (`organisation-lifecycle-port.ts`). See `purge-catalogue.ts` of tenancy
 * for the actions and the order rule.
 */
import type { PurgeCatalogueEntry } from "@purin-labs/tenancy/data/purge-catalogue";

export const ORGANISATION_PURGE_ENTRIES = [
  {
    order: 740,
    table: "organisation_communication_destination",
    action: "erase",
    statement: "DELETE FROM organisation_communication_destination",
  },
  {
    order: 750,
    table: "organisation_slack_channel",
    action: "erase",
    statement: "DELETE FROM organisation_slack_channel",
  },
  {
    order: 1140,
    table: "organisation_harness_erasure_session",
    action: "keep",
    reason:
      "The erasure receipt of each Session Actor. The erasure status reads it after the purge.",
  },
  {
    order: 1220,
    table: "onboarding_reconciliation_run",
    action: "keep",
    reason:
      "The receipt of each scheduled run. The purge run itself completes after the purge.",
  },
  {
    order: 1230,
    table: "onboarding_support_reference",
    action: "erase",
    statement: "DELETE FROM onboarding_support_reference",
  },
  {
    order: 1250,
    table: "operator_configuration_draft",
    action: "erase",
    statement: "DELETE FROM operator_configuration_draft",
  },
  {
    order: 1270,
    table: "organisation_first_operational_task",
    action: "erase",
    statement: "DELETE FROM organisation_first_operational_task",
  },
  {
    order: 1280,
    table: "organisation_activation_receipt",
    action: "erase",
    statement: "DELETE FROM organisation_activation_receipt",
  },
  {
    order: 1290,
    table: "organisation_activation_step",
    action: "erase",
    statement: "DELETE FROM organisation_activation_step",
    where:
      "activation_attempt_id IN (SELECT activation_attempt_id FROM organisation_activation_attempt WHERE organisation_id = ?)",
  },
  {
    order: 1300,
    table: "organisation_activation_attempt",
    action: "erase",
    statement: "DELETE FROM organisation_activation_attempt",
  },
  {
    order: 1400,
    table: "organisation_harness_erasure_object",
    action: "keep",
    reason: "The erasure receipt of each harness object.",
  },
  {
    order: 1410,
    table: "organisation_harness_erasure",
    action: "keep",
    reason: "The erasure ledger of the Organisation's harness history.",
  },
  {
    order: 1460,
    table: "organisation_onboarding_selection",
    action: "erase",
    statement: "DELETE FROM organisation_onboarding_selection",
  },
  {
    order: 1480,
    table: "organisation_readiness_assessment",
    action: "erase",
    statement: "DELETE FROM organisation_readiness_assessment",
  },
  {
    order: 1490,
    table: "organisation_setup_snapshot",
    action: "erase",
    statement: "DELETE FROM organisation_setup_snapshot",
  },
  {
    order: 1680,
    table: "provider_account_tombstone",
    action: "keep",
    reason: "Removal receipts with a hashed provider account and no content.",
  },
] as const satisfies readonly PurgeCatalogueEntry[];
