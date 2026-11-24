# The modules of the three layers

This page is made by `node scripts/check-layers.mjs --areas --write` from
`scripts/layers.json` and the tracked files. Do not edit it. `pnpm lint`
fails when the page is older than the map or the files: after a new folder, a
new table or a changed line of the map, write the page again. Each section is
one module, bottom-up: the foundation in its order, the areas, the surfaces
and the Workers ([Refactor 17](refactor-17.md)). "Folders" gives the folders
that hold the source files of the module. The page gives no file counts, so a
new file in a known folder does not make it old; `--areas` with no option
prints the counts. "Packages" gives its workspace packages. "Tables" gives the D1
tables that the module owns; only the owner writes a table, and the contract
of an area writes the tables of its area. "Public files" gives the public
files and folders of an area that another area may import. The module
`areas/<area>/contract` is the contract package of an area: another area may
import each of its files. A module with no line for one of these has none.

## foundation/std

- Packages: `packages/contract-schema`, `packages/std`, `packages/type-utils`

## foundation/async-control

- Packages: `packages/async-control`

## foundation/kernel

- Folders: 1
  - `foundation/kernel/`
- Packages: `foundation/kernel`

## foundation/contracts

- Packages: `packages/contracts`, `packages/control-api`

## foundation/tenancy

- Folders: 6
  - `foundation/tenancy/`
  - `foundation/tenancy/actors/`
  - `foundation/tenancy/actors/organisation/`
  - `foundation/tenancy/data/`
  - `foundation/tenancy/data/shared-rows/`
  - `foundation/tenancy/organisation-access/`
- Packages: `foundation/tenancy`
- Tables (17): `app_user`, `control_mutation_receipt`, `control_session`, `onboarding_audit_event`, `onboarding_event`, `organisation`, `organisation_archive_cleanup`, `organisation_archive_tombstone`, `organisation_invitation`, `organisation_onboarding`, `organisation_placement`, `person`, `service_role_grant`, `state_object_relocation`, `state_object_restore`, `surface_installation`, `workspace_ai_budget`

## foundation/actor-runtime

- Folders: 3
  - `foundation/actor-runtime/actors/`
  - `foundation/actor-runtime/actors/lifecycle/`
  - `foundation/actor-runtime/data/`
- Packages: `foundation/actor-runtime`
- Tables (5): `durable_object_registry`, `state_object_relocation_copy`, `state_object_relocation_exclusion`, `state_object_relocation_item`, `state_object_restore_item`

## foundation/connections

- Folders: 7
  - `foundation/connections/custom-connectors/`
  - `foundation/connections/data/`
  - `foundation/connections/external-records/`
  - `foundation/connections/mail/`
  - `foundation/connections/provider-adapters/`
  - `foundation/connections/slack/`
  - `foundation/connections/whatsapp/`
- Packages: `foundation/connections`
- Tables (15): `commerce_merchant_binding`, `integration_account`, `organisation_commerce_system`, `provider_authorization_state`, `provider_connection`, `provider_connection_attempt`, `provider_credential_generation`, `provider_default_account_history`, `provider_discovered_resource`, `provider_manifest_observation`, `provider_provisioning_attempt`, `provider_provisioning_receipt`, `provider_resource_cursor`, `provider_resource_snapshot`, `provider_webhook`

## foundation/authority

- Folders: 14
  - `foundation/authority/`
  - `foundation/authority/access-control/`
  - `foundation/authority/actors/`
  - `foundation/authority/actors/organisation/`
  - `foundation/authority/authorization/`
  - `foundation/authority/authorization/access-grants/`
  - `foundation/authority/credential-vault/`
  - `foundation/authority/data/`
  - `foundation/authority/policy/`
  - `foundation/authority/policy/information-flow/`
  - `foundation/authority/request-authority/`
  - `foundation/authority/seams/`
  - `foundation/authority/slack/`
  - `foundation/authority/vault-onepassword/`
- Packages: `foundation/authority`
- Tables (24): `access_grant`, `agent_permission_request`, `credential_access_denial`, `credential_ref`, `credential_revocation_operation`, `external_vault_import`, `held_output_request`, `organisation_capability_policy`, `person_authz_audit`, `person_authz_role`, `policy_snapshot`, `slack_channel_default`, `slack_channel_default_revision`, `slack_dm_organisation_selection_audit_event`, `slack_installation`, `slack_installation_audit_event`, `slack_installation_lifecycle_event`, `slack_organisation_connection`, `slack_routing_audit_event`, `vault_item`, `vault_item_event`, `vault_root_rotation_job`, `vault_secret`, `vault_store`

## foundation/control

- Folders: 5
  - `foundation/control/portal/`
  - `foundation/control/worker/`
  - `foundation/control/worker/admission/`
  - `foundation/control/worker/gateway/`
  - `foundation/control/worker/routes/`
- Packages: `foundation/control`
- Tables (1): `control_oidc_state`

## foundation/ui

- Folders: 4
  - `foundation/ui/`
  - `foundation/ui/features/`
  - `foundation/ui/features/chat/`
  - `foundation/ui/preferences/`
- Packages: `foundation/ui`

## foundation/agent-tools

- Folders: 6
  - `foundation/agent-tools/`
  - `foundation/agent-tools/catalog/`
  - `foundation/agent-tools/context/`
  - `foundation/agent-tools/files/`
  - `foundation/agent-tools/messages/`
  - `foundation/agent-tools/turn/`
- Packages: `foundation/agent-tools`

## foundation/agent

- Folders: 29
  - `foundation/agent/`
  - `foundation/agent/actors/`
  - `foundation/agent/actors/actor-journal/`
  - `foundation/agent/actors/organisation/`
  - `foundation/agent/actors/session/`
  - `foundation/agent/agent-tools/`
  - `foundation/agent/case-context-discovery/`
  - `foundation/agent/case-execution/`
  - `foundation/agent/chat/`
  - `foundation/agent/chatgpt-exit/`
  - `foundation/agent/code-mode-sandbox/`
  - `foundation/agent/context/`
  - `foundation/agent/context/assembly/`
  - `foundation/agent/context/files/`
  - `foundation/agent/context/projection/`
  - `foundation/agent/control/`
  - `foundation/agent/control/routes/`
  - `foundation/agent/control/routes/agents/`
  - `foundation/agent/cues/`
  - `foundation/agent/data/`
  - `foundation/agent/data/agent-operations/`
  - `foundation/agent/integrations/typesafe/`
  - `foundation/agent/jev-features/`
  - `foundation/agent/messages/`
  - `foundation/agent/model-exit/`
  - `foundation/agent/models/`
  - `foundation/agent/provider-adapters/`
  - `foundation/agent/provider-workflows/`
  - `foundation/agent/schedules/`
- Packages: `foundation/agent`
- Tables (35): `agent_area_assignment`, `agent_configuration_proposal`, `agent_definition`, `agent_definition_revision`, `agent_installation`, `agent_installation_governance`, `agent_responsibility_scope`, `case_assignment_pin`, `context_projection`, `cue_binding`, `cue_log`, `cue_subscription`, `file_extraction_budget`, `file_grant_admission`, `file_grant_sync`, `file_projection_outbox`, `file_provider_cursor`, `file_resource_source`, `operational_area`, `organisation_claude_authorization`, `organisation_claude_connection`, `organisation_codex_authorization_attempt`, `organisation_codex_connection`, `organisation_default_workspace`, `organisation_inference_selection`, `organisation_slack_reasoning_effort`, `organisation_workspace`, `schedule_binding`, `schedule_dispatch_receipt`, `skill`, `skill_binding`, `skill_revision`, `workspace_revision`, `workspace_revision_head`, `workspace_revision_receipt`

## foundation/conversation

- Folders: 13
  - `foundation/conversation/actors/`
  - `foundation/conversation/actors/case/`
  - `foundation/conversation/actors/connector/`
  - `foundation/conversation/case-context-discovery/`
  - `foundation/conversation/chat/`
  - `foundation/conversation/chat/turn/`
  - `foundation/conversation/control/admission/`
  - `foundation/conversation/control/routes/`
  - `foundation/conversation/control/routes/agents/`
  - `foundation/conversation/data/`
  - `foundation/conversation/messages/`
  - `foundation/conversation/projects/`
  - `foundation/conversation/slack/`
- Packages: `foundation/conversation`
- Tables (16): `case_project`, `organisation_default_project`, `portal_chat_conversation_access_operation`, `portal_chat_deletion`, `portal_chat_directory`, `portal_chat_directory_operation`, `portal_chat_directory_project`, `portal_chat_fork`, `portal_conversation`, `portal_conversation_user`, `project`, `project_access_operation`, `project_member`, `project_operation`, `session_turn_access`, `side_case_proposal`

## foundation/tool-handlers

- Folders: 5
  - `foundation/tool-handlers/actors/`
  - `foundation/tool-handlers/actors/session/`
  - `foundation/tool-handlers/agent-tools/`
  - `foundation/tool-handlers/agent-tools/files/`
  - `foundation/tool-handlers/slack/`
- Packages: `foundation/tool-handlers`

## foundation/collaboration

- Folders: 4
  - `packages/collaboration/portal/`
  - `packages/collaboration/src/`
  - `packages/collaboration/tests/`
  - `packages/collaboration/worker/`
- Packages: `packages/collaboration`

## areas/brain

- Folders: 8
  - `areas/brain/server/actors/`
  - `areas/brain/server/actors/connector/`
  - `areas/brain/server/case-execution/`
  - `areas/brain/server/control/routes/`
  - `areas/brain/server/evals/`
  - `areas/brain/server/memory/`
  - `areas/brain/ui/`
  - `areas/brain/ui/features/brain/`
- Packages: `areas/brain`

## areas/brain/contract

- Folders: 4
  - `areas/brain/contract/server/evals/`
  - `areas/brain/contract/server/memory/`
  - `areas/brain/contract/ui/`
  - `areas/brain/contract/ui/features/brain/`
- Packages: `areas/brain/contract`

## areas/cafe

- Folders: 12
  - `areas/cafe/server/`
  - `areas/cafe/server/actors/`
  - `areas/cafe/server/agent-tools/commerce/`
  - `areas/cafe/server/agent-tools/drafts/`
  - `areas/cafe/server/control/admission/`
  - `areas/cafe/server/control/routes/`
  - `areas/cafe/server/data/`
  - `areas/cafe/ui/features/content-studio/`
  - `areas/cafe/ui/features/menu-boards/`
  - `areas/cafe/ui/features/order-queue/`
  - `areas/cafe/ui/features/register/`
  - `areas/cafe/ui/features/terminals/`
- Packages: `areas/cafe`, `packages/cafe-control-api`, `packages/menu-board-crdt`, `packages/menu-draft-crdt`
- Tables (3): `cafe_counter_receipt_setting`, `cafe_terminal_assignment`, `screen_pairing`

## areas/cafe/contract

- Folders: 1
  - `areas/cafe/contract/server/`
- Packages: `areas/cafe/contract`

## areas/commerce

- Folders: 28
  - `areas/commerce/server/`
  - `areas/commerce/server/actors/`
  - `areas/commerce/server/actors/commerce-projection/`
  - `areas/commerce/server/actors/organisation/`
  - `areas/commerce/server/agent-tools/commerce/`
  - `areas/commerce/server/commerce-lab/`
  - `areas/commerce/server/contract/`
  - `areas/commerce/server/control/`
  - `areas/commerce/server/control/admission/`
  - `areas/commerce/server/control/routes/`
  - `areas/commerce/server/control/routes/commerce/`
  - `areas/commerce/server/data/`
  - `areas/commerce/server/entity-plane/`
  - `areas/commerce/server/payout-providers/`
  - `areas/commerce/server/payouts/`
  - `areas/commerce/server/stripe/`
  - `areas/commerce/ui/`
  - `areas/commerce/ui/features/api-keys/`
  - `areas/commerce/ui/features/bank-payouts/`
  - `areas/commerce/ui/features/checkout-profiles/`
  - `areas/commerce/ui/features/commerce/`
  - `areas/commerce/ui/features/commerce/description-draft/`
  - `areas/commerce/ui/features/commerce/entity-plane/`
  - `areas/commerce/ui/features/governed-actions/`
  - `areas/commerce/ui/features/orders/`
  - `areas/commerce/ui/features/payment-accounts/`
  - `areas/commerce/ui/features/payments/`
  - `areas/commerce/ui/features/payouts/`
- Packages: `areas/commerce`, `packages/commerce-client`, `packages/commerce-contracts`, `packages/commerce-control-api`, `packages/commerce-query-sqlite`, `packages/product-description-crdt`, `services/commerce`
- Tables (12): `commerce_capability_activation`, `commerce_export_preset_publication`, `commerce_lab_organisation`, `commerce_lab_run`, `commerce_webhook_subscription`, `paid_receipt`, `supplier_destination_revision`, `supplier_payable`, `supplier_payout`, `supplier_payout_attempt`, `supplier_payout_certification`, `supplier_payout_event`
- Public files: `areas/commerce/server/contract/`, `areas/commerce/ui/features/commerce/description-draft/styles.css`, `areas/commerce/ui/features/commerce/entity-plane/api.ts`, `areas/commerce/ui/features/commerce/operations.ts`, `areas/commerce/ui/features/commerce/stock-status.ts`, `areas/commerce/ui/features/governed-actions/commerce.ts`, `areas/commerce/ui/features/governed-actions/decision-labels.ts`, `packages/commerce-contracts`

## areas/devices

- Folders: 6
  - `areas/devices/server/`
  - `areas/devices/server/actors/`
  - `areas/devices/server/agent-tools/devices/`
  - `areas/devices/server/contract/`
  - `areas/devices/server/control/routes/`
  - `areas/devices/ui/features/devices/`
- Packages: `areas/devices`
- Tables (7): `device_alert`, `device_alert_setting`, `device_camera_policy`, `device_enrollment`, `device_event`, `device_gateway`, `device_snapshot`
- Public files: `areas/devices/server/contract/`

## areas/devices/contract

- Folders: 1
  - `areas/devices/contract/server/`
- Packages: `areas/devices/contract`

## areas/inbox

- Folders: 16
  - `areas/inbox/server/actors/`
  - `areas/inbox/server/actors/case-inbox/`
  - `areas/inbox/server/actors/inbox-turns/`
  - `areas/inbox/server/actors/organisation/`
  - `areas/inbox/server/agent-tools/channels/`
  - `areas/inbox/server/case-context-discovery/`
  - `areas/inbox/server/control/`
  - `areas/inbox/server/control/admission/`
  - `areas/inbox/server/control/routes/`
  - `areas/inbox/server/control/routes/agents/`
  - `areas/inbox/server/data/`
  - `areas/inbox/server/mail-inbox/`
  - `areas/inbox/server/mail-inbox/contract/`
  - `areas/inbox/server/whatsapp/`
  - `areas/inbox/ui/features/mail-inbox/`
  - `areas/inbox/ui/features/mail-setup/`
- Packages: `areas/inbox`, `packages/email-draft-crdt`, `packages/inbox-control-api`, `packages/mail-reply-crdt`
- Tables (26): `agent_mailbox_binding`, `agent_mailbox_binding_revision`, `contact_endpoint_verification`, `email_mailbox_account`, `email_message_receipt`, `email_operational_attestation`, `email_operational_contact`, `email_operational_proposal_projection`, `email_reply_proposal`, `email_self_test`, `email_sender_account`, `email_thread_case`, `gmail_inference_eligibility`, `mail_assistant_eligibility`, `mail_classification`, `mailbox_ingress_policy`, `mailbox_ingress_policy_revision`, `whatsapp_case_conversation_window`, `whatsapp_delivery_status`, `whatsapp_ingress_policy`, `whatsapp_ingress_policy_revision`, `whatsapp_message_receipt`, `whatsapp_phone_number_account`, `whatsapp_reply_proposal`, `whatsapp_support_binding`, `whatsapp_support_binding_revision`
- Public files: `areas/inbox/server/mail-inbox/contract/`, `areas/inbox/ui/features/mail-setup/`

## areas/inbox/contract

- Folders: 5
  - `areas/inbox/contract/server/`
  - `areas/inbox/contract/ui/`
  - `areas/inbox/contract/ui/features/email-review/`
  - `areas/inbox/contract/ui/features/mail-setup/`
  - `areas/inbox/contract/ui/pages/`
- Packages: `areas/inbox/contract`

## areas/integrations

- Folders: 21
  - `areas/integrations/server/`
  - `areas/integrations/server/actors/`
  - `areas/integrations/server/agent-tools/integrations/`
  - `areas/integrations/server/agent-tools/jev/`
  - `areas/integrations/server/contract/`
  - `areas/integrations/server/control/routes/`
  - `areas/integrations/server/control/routes/custom-connectors/`
  - `areas/integrations/server/control/routes/integrations/`
  - `areas/integrations/server/custom-connectors/`
  - `areas/integrations/server/data/`
  - `areas/integrations/server/external-records/`
  - `areas/integrations/server/gateway/`
  - `areas/integrations/server/jev-features/`
  - `areas/integrations/server/provider-adapters/`
  - `areas/integrations/server/provider-lifecycle/`
  - `areas/integrations/server/provider-workflows/`
  - `areas/integrations/ui/`
  - `areas/integrations/ui/features/integrations/`
  - `areas/integrations/ui/features/jev-features/`
  - `areas/integrations/ui/features/vault/`
  - `areas/integrations/ui/pages/`
- Packages: `areas/integrations`
- Tables (8): `credential_rotation`, `custom_connector`, `custom_connector_account_binding`, `custom_connector_revision`, `custom_connector_setup_attempt`, `discord_interaction_install`, `mail_classification_eligibility`, `provider_account_cleanup`
- Public files: `areas/integrations/server/contract/`, `areas/integrations/ui/features/integrations/connect-consent-dialog.tsx`, `areas/integrations/ui/provider-onboarding.tsx`

## areas/integrations/contract

- Folders: 5
  - `areas/integrations/contract/server/`
  - `areas/integrations/contract/server/mail/`
  - `areas/integrations/contract/ui/`
  - `areas/integrations/contract/ui/features/integrations/`
  - `areas/integrations/contract/ui/features/jev-features/`
- Packages: `areas/integrations/contract`

## areas/kitchen

- Folders: 31
  - `areas/kitchen/server/`
  - `areas/kitchen/server/actors/`
  - `areas/kitchen/server/agent-tools/bakery/`
  - `areas/kitchen/server/agent-tools/costs/`
  - `areas/kitchen/server/agent-tools/kitchen/`
  - `areas/kitchen/server/bakery/`
  - `areas/kitchen/server/bakes/`
  - `areas/kitchen/server/control/admission/`
  - `areas/kitchen/server/control/routes/`
  - `areas/kitchen/server/data/`
  - `areas/kitchen/server/purchasing/`
  - `areas/kitchen/ui/features/`
  - `areas/kitchen/ui/features/bakes/`
  - `areas/kitchen/ui/features/costs/`
  - `areas/kitchen/ui/features/production-run/`
  - `areas/kitchen/ui/features/production-run/black-sesame/`
  - `areas/kitchen/ui/features/production-run/cafe-shift/`
  - `areas/kitchen/ui/features/production-run/financier-bake/`
  - `areas/kitchen/ui/features/production-run/financier-batter/`
  - `areas/kitchen/ui/features/production-run/financier-pack/`
  - `areas/kitchen/ui/features/production-run/ginger-tea/`
  - `areas/kitchen/ui/features/production-run/latte/`
  - `areas/kitchen/ui/features/production-run/linea/`
  - `areas/kitchen/ui/features/production-run/pastry-bench/`
  - `areas/kitchen/ui/features/production-run/pour-over/`
  - `areas/kitchen/ui/features/production-run/shared/`
  - `areas/kitchen/ui/features/production-run/siphon/`
  - `areas/kitchen/ui/features/recipes/`
  - `areas/kitchen/ui/features/workflow-simulator/`
  - `areas/kitchen/ui/features/workflow-simulator/docks/`
  - `areas/kitchen/ui/features/workflow-simulator/spatial/`
- Packages: `areas/kitchen`, `packages/bakery-model`, `packages/bakery-workflow`, `packages/costs-sheet-crdt`, `packages/kitchen-control-api`, `packages/production-plan-crdt`, `packages/production-simulation`, `packages/workflow-canvas-crdt`
- Tables (13): `bake_authority`, `bake_proposal`, `bake_run`, `bake_stock_level`, `bakery_agent_run_save`, `bakery_agent_scenario_save`, `bakery_cost_plan`, `bakery_cost_product_plan`, `bakery_lot_invoice_cost`, `bakery_surface_effect_delivery`, `bakery_surface_timeline_event`, `bakery_workflow`, `bakery_workflow_revision`

## areas/kitchen/contract

- Folders: 4
  - `areas/kitchen/contract/server/`
  - `areas/kitchen/contract/server/agent-tools/bakery/`
  - `areas/kitchen/contract/server/agent-tools/kitchen/`
  - `areas/kitchen/contract/ui/features/`
- Packages: `areas/kitchen/contract`

## areas/organisation

- Folders: 11
  - `areas/organisation/server/actors/organisation/`
  - `areas/organisation/server/agent-tools/organisation/`
  - `areas/organisation/server/contract/`
  - `areas/organisation/server/control/`
  - `areas/organisation/server/control/routes/`
  - `areas/organisation/server/data/`
  - `areas/organisation/ui/`
  - `areas/organisation/ui/features/access/`
  - `areas/organisation/ui/features/agent-schedules/`
  - `areas/organisation/ui/features/billing/`
  - `areas/organisation/ui/pages/`
- Packages: `areas/organisation`
- Tables (20): `control_support_role`, `onboarding_reconciliation_run`, `onboarding_support_access_audit`, `onboarding_support_reference`, `operator_configuration_draft`, `organisation_activation_attempt`, `organisation_activation_receipt`, `organisation_activation_step`, `organisation_communication_destination`, `organisation_first_operational_task`, `organisation_harness_erasure`, `organisation_harness_erasure_object`, `organisation_harness_erasure_session`, `organisation_onboarding_selection`, `organisation_readiness_assessment`, `organisation_setup_snapshot`, `organisation_slack_channel`, `provider_account_tombstone`, `provider_manifest`, `user_preferences`
- Public files: `areas/organisation/server/contract/`, `areas/organisation/ui/pages/account-invitation-link.ts`

## areas/organisation/contract

- Folders: 3
  - `areas/organisation/contract/server/`
  - `areas/organisation/contract/ui/features/access/`
  - `areas/organisation/contract/ui/pages/`
- Packages: `areas/organisation/contract`

## areas/shopify

- Folders: 2
  - `areas/integrations/shopify/`
  - `areas/integrations/shopify/connector/`

## surfaces/docs-site

- Packages: `apps/docs`

## surfaces/email

- Folders: 4
  - `surfaces/email/server/actors/`
  - `surfaces/email/server/actors/connector/`
  - `surfaces/email/server/gateway/`
  - `surfaces/email/server/mail/`
- Packages: `surfaces/email`

## surfaces/portal

- Folders: 12
  - `apps/portal/src/`
  - `apps/portal/src/dev/`
  - `apps/portal/src/tv/`
  - `surfaces/portal/server/chat/`
  - `surfaces/portal/server/chat/turn/`
  - `surfaces/portal/server/control/routes/`
  - `surfaces/portal/server/control/routes/chat/`
  - `surfaces/portal/ui/`
  - `surfaces/portal/ui/features/chat/`
  - `surfaces/portal/ui/features/integrations/`
  - `surfaces/portal/ui/pages/`
  - `surfaces/portal/ui/tv/`
- Packages: `apps/portal`, `surfaces/portal`

## surfaces/slack

- Folders: 8
  - `surfaces/slack/server/`
  - `surfaces/slack/server/actors/`
  - `surfaces/slack/server/actors/connector/`
  - `surfaces/slack/server/agent-tools/slack/`
  - `surfaces/slack/server/control/routes/`
  - `surfaces/slack/server/data/`
  - `surfaces/slack/server/gateway-routing/`
  - `surfaces/slack/server/slack-ingress/`
- Packages: `surfaces/slack`
- Tables (6): `external_identity_link`, `external_identity_link_challenge`, `slack_conversation_fact`, `slack_dm_organisation_selection`, `slack_message_proposal`, `slack_thread_case_pin`

## surfaces/storefront

- Packages: `apps/storefront`

## surfaces/voice

- Folders: 3
  - `surfaces/voice/server/`
  - `surfaces/voice/server/engines/`
  - `surfaces/voice/ui/features/voice/`
- Packages: `surfaces/voice`
- Tables (3): `voice_confirmation`, `voice_mac`, `voice_transcription_use`

## surfaces/webhooks

- Folders: 4
  - `surfaces/webhooks/server/`
  - `surfaces/webhooks/server/gateway-routing/`
  - `surfaces/webhooks/server/gateway/`
  - `surfaces/webhooks/server/gateway/admin/`
- Packages: `surfaces/webhooks`

## surfaces/whatsapp

- Folders: 3
  - `surfaces/whatsapp/server/`
  - `surfaces/whatsapp/server/actors/`
  - `surfaces/whatsapp/server/actors/connector/`
- Packages: `surfaces/whatsapp`

## workers/platform

- Folders: 11
  - `workers/platform/src/`
  - `workers/platform/src/actors/`
  - `workers/platform/src/actors/organisation/`
  - `workers/platform/src/agent-tools/`
  - `workers/platform/src/chatgpt-exit/`
  - `workers/platform/src/code-mode-sandbox/`
  - `workers/platform/src/control/`
  - `workers/platform/src/control/routes/`
  - `workers/platform/src/model-exit/`
  - `workers/platform/src/slack-ingress/`
  - `workers/platform/src/vault-onepassword/`
- Packages: `workers/platform`
- Tables (3): `thread_binding`, `thread_file_watch`, `tool_call`

## workers/punter

- Packages: `scripts/punter`
