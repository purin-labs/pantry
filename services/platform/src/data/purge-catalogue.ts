/**
 * What the purge does with each regional table (Refactor 15, refactor 5).
 * Every table of the regional baseline has one entry; `pnpm
 * lint:purge-catalogue` (scripts/check-purge-catalogue.mjs) refuses a table
 * with no entry, an entry for a table that does not exist, and an order in
 * which a row would be erased before a row that refers to it.
 *
 * - `erase`: the purge deletes every row of the Organisation. `where`
 *   selects the rows of a table with no `organisation_id` column; its one
 *   `?` is the Organisation id.
 * - `pseudonymize`: the row stays, because other rows refer to it, but it
 *   loses what identifies a person or a provider account. The purge names a
 *   rewrite for each such table.
 * - `keep`: the row stays as it is. It is a receipt of the purge, or the
 *   placement owns it. The reason says which.
 *
 * The purge runs the entries in this order, so a table comes before every
 * table that it refers to.
 */
type PurgeCatalogueEntry =
  | Readonly<{ table: string; action: "erase"; where?: string }>
  | Readonly<{
      table: string;
      action: "pseudonymize" | "keep";
      reason: string;
    }>;

export const PURGE_CATALOGUE = [
  { table: "file_grant_admission", action: "erase" },
  { table: "file_grant_sync", action: "erase" },
  { table: "file_projection_outbox", action: "erase" },
  { table: "access_grant", action: "erase" },
  {
    table: "account_service_access_revision",
    action: "erase",
    where: "native_organisation_id = ?",
  },
  {
    table: "account_service_invitation_role",
    action: "erase",
    where: "native_organisation_id = ?",
  },
  {
    table: "agent_area_assignment",
    action: "erase",
    where:
      "installation_id IN (SELECT installation_id FROM agent_installation WHERE organisation_id = ?)",
  },
  { table: "agent_configuration_proposal", action: "erase" },
  { table: "agent_installation_governance", action: "erase" },
  { table: "email_thread_case", action: "erase" },
  { table: "agent_mailbox_binding_revision", action: "erase" },
  { table: "case_assignment_pin", action: "erase" },
  { table: "cue_binding", action: "erase" },
  { table: "schedule_dispatch_receipt", action: "erase" },
  { table: "schedule_binding", action: "erase" },
  { table: "whatsapp_case_conversation_window", action: "erase" },
  { table: "whatsapp_support_binding_revision", action: "erase" },
  { table: "agent_installation", action: "erase" },
  { table: "agent_definition_revision", action: "erase" },
  { table: "agent_definition", action: "erase" },
  { table: "agent_mailbox_binding", action: "erase" },
  { table: "agent_permission_request", action: "erase" },
  { table: "agent_responsibility_scope", action: "erase" },
  { table: "bakery_agent_run_save", action: "erase" },
  { table: "bakery_agent_scenario_save", action: "erase" },
  { table: "bakery_cost_plan", action: "erase" },
  { table: "bakery_cost_product_plan", action: "erase" },
  { table: "bakery_lot_invoice_cost", action: "erase" },
  { table: "bakery_surface_timeline_event", action: "erase" },
  { table: "bakery_surface_effect_delivery", action: "erase" },
  { table: "bakery_workflow", action: "erase" },
  { table: "bakery_workflow_revision", action: "erase" },
  { table: "cafe_counter_receipt_setting", action: "erase" },
  { table: "cafe_terminal_assignment", action: "erase" },
  { table: "campaign_brief", action: "erase" },
  { table: "portal_conversation_user", action: "erase" },
  { table: "session_turn_access", action: "erase" },
  { table: "portal_conversation", action: "erase" },
  { table: "case_project", action: "erase" },
  { table: "commerce_capability_activation", action: "erase" },
  { table: "commerce_export_preset_publication", action: "erase" },
  { table: "commerce_lab_run", action: "erase" },
  { table: "commerce_lab_organisation", action: "erase" },
  { table: "connector", action: "erase" },
  { table: "contact_endpoint_verification", action: "erase" },
  { table: "context_projection", action: "erase" },
  { table: "context_projection_fts", action: "erase" },
  {
    table: "control_mutation_receipt",
    action: "keep",
    reason:
      "Idempotency receipts of control requests. They hold no Organisation data beyond the request scope, and each one expires on its own; the purge deletes the expired ones.",
  },
  {
    table: "credential_access_denial",
    action: "keep",
    reason:
      "Metadata of each refused credential read: its purpose, its reason and the handle, with no secret. It is the audit of access after the archive.",
  },
  { table: "credential_ref", action: "erase" },
  {
    table: "credential_revocation_operation",
    action: "keep",
    reason:
      "Counts of what each credential revocation removed: the receipt that the revocation happened.",
  },
  { table: "credential_rotation", action: "erase" },
  { table: "cue_log", action: "erase" },
  { table: "cue_subscription", action: "erase" },
  { table: "custom_connector_setup_attempt", action: "erase" },
  { table: "custom_connector_account_binding", action: "erase" },
  { table: "custom_connector_revision", action: "erase" },
  { table: "email_message_receipt", action: "erase" },
  { table: "email_reply_proposal", action: "erase" },
  { table: "mailbox_ingress_policy", action: "erase" },
  { table: "mailbox_ingress_policy_revision", action: "erase" },
  {
    table: "email_mailbox_account",
    action: "pseudonymize",
    reason:
      "The Google account gives up its subject and its address, so that a new Organisation can connect it.",
  },
  { table: "email_operational_attestation", action: "erase" },
  { table: "email_operational_proposal_projection", action: "erase" },
  { table: "email_self_test", action: "erase" },
  {
    table: "email_sender_account",
    action: "pseudonymize",
    reason:
      "The Google account gives up its subject and its address, so that a new Organisation can connect it.",
  },
  { table: "file_extraction_budget", action: "erase" },
  { table: "file_provider_cursor", action: "erase" },
  { table: "file_resource_source", action: "erase" },
  { table: "mail_assistant_eligibility", action: "erase" },
  { table: "mail_classification", action: "erase" },
  { table: "mail_classification_eligibility", action: "erase" },
  { table: "organisation_commerce_system", action: "erase" },
  { table: "organisation_communication_destination", action: "erase" },
  { table: "organisation_slack_channel", action: "erase" },
  { table: "provider_account_cleanup", action: "erase" },
  { table: "provider_authorization_state", action: "erase" },
  {
    table: "provider_provisioning_receipt",
    action: "erase",
    where:
      "provisioning_attempt_id IN (SELECT provisioning_attempt_id FROM provider_provisioning_attempt WHERE organisation_id = ?)",
  },
  { table: "provider_provisioning_attempt", action: "erase" },
  { table: "provider_connection_attempt", action: "erase" },
  { table: "provider_default_account_history", action: "erase" },
  { table: "provider_manifest_observation", action: "erase" },
  { table: "provider_resource_cursor", action: "erase" },
  {
    table: "provider_discovered_resource",
    action: "erase",
    where:
      "snapshot_revision IN (SELECT snapshot_revision FROM provider_resource_snapshot WHERE organisation_id = ?)",
  },
  { table: "provider_resource_snapshot", action: "erase" },
  { table: "provider_webhook", action: "erase" },
  { table: "slack_message_proposal", action: "erase" },
  { table: "supplier_payout_certification", action: "erase" },
  { table: "surface_installation", action: "erase" },
  { table: "thread_binding", action: "erase" },
  { table: "thread_file_watch", action: "erase" },
  { table: "tool_call", action: "erase" },
  { table: "whatsapp_delivery_status", action: "erase" },
  { table: "whatsapp_ingress_policy", action: "erase" },
  { table: "whatsapp_ingress_policy_revision", action: "erase" },
  { table: "whatsapp_message_receipt", action: "erase" },
  { table: "whatsapp_reply_proposal", action: "erase" },
  { table: "whatsapp_support_binding", action: "erase" },
  { table: "whatsapp_phone_number_account", action: "erase" },
  {
    table: "integration_account",
    action: "pseudonymize",
    reason:
      "Each account loses its provider identity and is revoked; the directory's revoked Slack connections name it. A custom API account is erased with its connector.",
  },
  { table: "external_identity_link", action: "erase" },
  { table: "external_identity_link_challenge", action: "erase" },
  {
    table: "provider_credential_generation",
    action: "pseudonymize",
    reason:
      "Each generation loses its credential reference. The generations of a custom API connection are erased.",
  },
  {
    table: "provider_connection",
    action: "pseudonymize",
    reason:
      "Each connection loses its provider subject and its credential reference and is revoked. A custom API connection is erased with its connector.",
  },
  { table: "custom_connector", action: "erase" },
  { table: "device_alert", action: "erase" },
  { table: "device_alert_setting", action: "erase" },
  { table: "device_camera_policy", action: "erase" },
  { table: "device_enrollment", action: "erase" },
  { table: "device_event", action: "erase" },
  { table: "device_gateway", action: "erase" },
  { table: "device_snapshot", action: "erase" },
  { table: "discord_interaction_install", action: "erase" },
  {
    table: "organisation_harness_erasure_session",
    action: "keep",
    reason:
      "The erasure receipt of each Session Actor. The erasure status reads it after the purge.",
  },
  {
    table: "durable_object_registry",
    action: "keep",
    reason:
      "The Actor registry, which the placement owns. The harness erasure empties the Actors that it names.",
  },
  { table: "email_operational_contact", action: "erase" },
  { table: "escalation_policy", action: "erase" },
  { table: "external_vault_import", action: "erase" },
  { table: "gmail_inference_eligibility", action: "erase" },
  { table: "held_output_request", action: "erase" },
  { table: "install", action: "erase" },
  {
    table: "onboarding_audit_event",
    action: "keep",
    reason:
      "Audit of lifecycle mutations, with hashed subjects. The archive, delete and purge decisions are proved by it.",
  },
  {
    table: "onboarding_event",
    action: "keep",
    reason:
      "Lifecycle events with hashed subjects. The scheduled run writes its own events, also in the purge run.",
  },
  {
    table: "onboarding_reconciliation_run",
    action: "keep",
    reason:
      "The receipt of each scheduled run. The purge run itself completes after the purge.",
  },
  { table: "onboarding_support_reference", action: "erase" },
  { table: "operational_area", action: "erase" },
  { table: "operator_configuration_draft", action: "erase" },
  {
    table: "organisation",
    action: "pseudonymize",
    reason:
      "The row stays, as other rows and the directory refer to it. It loses its name and its handle, and says purged.",
  },
  { table: "organisation_first_operational_task", action: "erase" },
  { table: "organisation_activation_receipt", action: "erase" },
  {
    table: "organisation_activation_step",
    action: "erase",
    where:
      "activation_attempt_id IN (SELECT activation_attempt_id FROM organisation_activation_attempt WHERE organisation_id = ?)",
  },
  { table: "organisation_activation_attempt", action: "erase" },
  {
    table: "organisation_archive_cleanup",
    action: "keep",
    reason:
      "The archive cleanup state. It says purged after the purge, and the erasure status reads it.",
  },
  {
    table: "organisation_archive_tombstone",
    action: "keep",
    reason:
      "The archive receipt: who archived the Organisation, when, and when it was purged.",
  },
  { table: "organisation_capability_policy", action: "erase" },
  { table: "organisation_claude_authorization", action: "erase" },
  { table: "organisation_claude_connection", action: "erase" },
  { table: "organisation_codex_authorization_attempt", action: "erase" },
  { table: "organisation_codex_connection", action: "erase" },
  { table: "organisation_default_project", action: "erase" },
  { table: "organisation_default_workspace", action: "erase" },
  {
    table: "organisation_harness_erasure_object",
    action: "keep",
    reason: "The erasure receipt of each harness object.",
  },
  {
    table: "organisation_harness_erasure",
    action: "keep",
    reason: "The erasure ledger of the Organisation's harness history.",
  },
  { table: "organisation_inference_selection", action: "erase" },
  {
    table: "organisation_onboarding",
    action: "keep",
    reason: "The lifecycle row. It says purged after the purge.",
  },
  { table: "organisation_onboarding_selection", action: "erase" },
  {
    table: "organisation_placement",
    action: "keep",
    reason: "The placement and its fence, which the placement owns.",
  },
  { table: "organisation_readiness_assessment", action: "erase" },
  { table: "organisation_setup_snapshot", action: "erase" },
  { table: "organisation_slack_reasoning_effort", action: "erase" },
  { table: "organisation_workspace", action: "erase" },
  { table: "paid_receipt", action: "erase" },
  { table: "person_authz_role", action: "erase" },
  { table: "project_member", action: "erase" },
  { table: "service_role_grant", action: "erase" },
  { table: "person", action: "erase" },
  { table: "person_authz_audit", action: "erase" },
  { table: "policy_snapshot", action: "erase" },
  { table: "portal_chat_conversation_access_operation", action: "erase" },
  { table: "portal_chat_deletion", action: "erase" },
  { table: "portal_chat_directory_operation", action: "erase" },
  { table: "portal_chat_directory", action: "erase" },
  { table: "portal_chat_directory_project", action: "erase" },
  { table: "portal_chat_fork", action: "erase" },
  { table: "project_access_operation", action: "erase" },
  { table: "project", action: "erase" },
  { table: "project_operation", action: "erase" },
  {
    table: "provider_account_tombstone",
    action: "keep",
    reason: "Removal receipts with a hashed provider account and no content.",
  },
  { table: "side_case_proposal", action: "erase" },
  { table: "skill_binding", action: "erase" },
  { table: "skill_revision", action: "erase" },
  { table: "skill", action: "erase" },
  { table: "slack_conversation_fact", action: "erase" },
  { table: "supplier_destination_revision", action: "erase" },
  { table: "supplier_payout", action: "erase" },
  { table: "supplier_payable", action: "erase" },
  { table: "supplier_payout_attempt", action: "erase" },
  { table: "supplier_payout_event", action: "erase" },
  { table: "underclerk_webhook_subscription", action: "erase" },
  { table: "underclerk_merchant_binding", action: "erase" },
  { table: "vault_item", action: "erase" },
  { table: "vault_item_event", action: "erase" },
  { table: "vault_secret", action: "erase" },
  { table: "vault_store", action: "erase" },
  { table: "voice_confirmation", action: "erase" },
  { table: "voice_mac", action: "erase" },
  { table: "voice_transcription_use", action: "erase" },
  { table: "workspace_ai_budget", action: "erase" },
  { table: "workspace_revision_receipt", action: "erase" },
  { table: "workspace_revision", action: "erase" },
  { table: "workspace_revision_head", action: "erase" },
] as const satisfies readonly PurgeCatalogueEntry[];

/** The rows of the Organisation that an erase entry selects. */
export function eraseEntryWhere(
  entry: Readonly<{ action: "erase"; where?: string }>,
): string {
  return entry.where ?? "organisation_id = ?";
}
