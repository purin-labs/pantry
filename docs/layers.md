# The modules of the three layers

This page is made by `node scripts/check-layers.mjs --areas --write` from
`scripts/layers.json` and the tracked files. Do not edit it. `pnpm lint`
fails when the page is older than the map or the files: after a new file, a
new table or a changed line of the map, write the page again. Each section is
one module, bottom-up: the foundation in its order, the areas, the surfaces
and the Workers ([Refactor 17](refactor-17.md)). "Files" gives the count of
the source files of the module and the folders that hold them, with the count
in each folder. "Packages" gives its workspace packages. "Tables" gives the D1
tables that the module owns; only the owner writes a table. "Public files"
gives the contract of an area: the files and folders that another area may
import. A module with no line for one of these has none.

## foundation/std

- Packages: `packages/contract-schema`, `packages/std`, `packages/type-utils`

## foundation/async-control

- Packages: `packages/async-control`

## foundation/kernel

- Files: 16 in 1 folders
  - `services/platform/src/` 16

## foundation/contracts

- Files: 1 in 1 folders
  - `services/platform/src/` 1
- Packages: `packages/contracts`, `packages/control-api`

## foundation/tenancy

- Files: 40 in 7 folders
  - `services/platform/src/` 3
  - `services/platform/src/account-platform/` 10
  - `services/platform/src/actors/` 1
  - `services/platform/src/actors/organisation/` 3
  - `services/platform/src/data/` 17
  - `services/platform/src/data/shared-rows/` 5
  - `services/platform/src/organisation-access/` 1
- Tables (21): `account_automation_link`, `account_identity_link`, `account_provision_receipt`, `account_service_access_revision`, `account_service_binding`, `app_user`, `control_mutation_receipt`, `control_session`, `onboarding_audit_event`, `onboarding_event`, `organisation`, `organisation_archive_cleanup`, `organisation_archive_tombstone`, `organisation_onboarding`, `organisation_placement`, `person`, `service_role_grant`, `state_object_relocation`, `state_object_restore`, `surface_installation`, `workspace_ai_budget`

## foundation/actor-runtime

- Files: 30 in 3 folders
  - `services/platform/src/actors/` 25
  - `services/platform/src/actors/lifecycle/` 4
  - `services/platform/src/data/` 1
- Tables (5): `durable_object_registry`, `state_object_relocation_copy`, `state_object_relocation_exclusion`, `state_object_relocation_item`, `state_object_restore_item`

## foundation/connections

- Files: 26 in 7 folders
  - `services/platform/src/custom-connectors/` 1
  - `services/platform/src/data/` 12
  - `services/platform/src/external-records/` 1
  - `services/platform/src/mail/` 7
  - `services/platform/src/provider-adapters/` 1
  - `services/platform/src/slack/` 1
  - `services/platform/src/whatsapp/` 3
- Tables (15): `integration_account`, `organisation_commerce_system`, `provider_authorization_state`, `provider_connection`, `provider_connection_attempt`, `provider_credential_generation`, `provider_default_account_history`, `provider_discovered_resource`, `provider_manifest_observation`, `provider_provisioning_attempt`, `provider_provisioning_receipt`, `provider_resource_cursor`, `provider_resource_snapshot`, `provider_webhook`, `underclerk_merchant_binding`

## foundation/authority

- Files: 79 in 14 folders
  - `services/platform/src/` 5
  - `services/platform/src/access-control/` 8
  - `services/platform/src/actors/` 2
  - `services/platform/src/actors/organisation/` 1
  - `services/platform/src/authorization/` 2
  - `services/platform/src/authorization/access-grants/` 10
  - `services/platform/src/credential-vault/` 22
  - `services/platform/src/data/` 8
  - `services/platform/src/policy/` 1
  - `services/platform/src/policy/information-flow/` 12
  - `services/platform/src/request-authority/` 1
  - `services/platform/src/seams/` 1
  - `services/platform/src/slack/` 3
  - `services/platform/src/vault-onepassword/` 3
- Tables (24): `access_grant`, `agent_permission_request`, `credential_access_denial`, `credential_ref`, `credential_revocation_operation`, `external_vault_import`, `held_output_request`, `organisation_capability_policy`, `person_authz_audit`, `person_authz_role`, `policy_snapshot`, `slack_channel_default`, `slack_channel_default_revision`, `slack_dm_organisation_selection_audit_event`, `slack_installation`, `slack_installation_audit_event`, `slack_installation_lifecycle_event`, `slack_organisation_connection`, `slack_routing_audit_event`, `vault_item`, `vault_item_event`, `vault_root_rotation_job`, `vault_secret`, `vault_store`

## foundation/control

- Files: 26 in 5 folders
  - `apps/portal/src/` 5
  - `services/platform/src/control/` 13
  - `services/platform/src/control/admission/` 2
  - `services/platform/src/control/routes/` 5
  - `services/platform/src/gateway/` 1
- Tables (1): `control_oidc_state`

## foundation/ui

- Files: 62 in 5 folders
  - `apps/portal/src/` 13
  - `apps/portal/src/features/` 3
  - `apps/portal/src/features/chat/` 1
  - `apps/portal/src/preferences/` 3
  - `apps/portal/src/ui/` 42

## foundation/agent-tools

- Files: 16 in 6 folders
  - `services/platform/src/agent-tools/` 6
  - `services/platform/src/agent-tools/catalog/` 6
  - `services/platform/src/agent-tools/files/` 1
  - `services/platform/src/agent-tools/messages/` 1
  - `services/platform/src/agent-tools/turn/` 1
  - `services/platform/src/context/` 1

## foundation/agent

- Files: 208 in 30 folders
  - `services/platform/src/` 5
  - `services/platform/src/account-platform/` 1
  - `services/platform/src/actors/` 75
  - `services/platform/src/actors/actor-journal/` 4
  - `services/platform/src/actors/organisation/` 3
  - `services/platform/src/actors/session/` 25
  - `services/platform/src/agent-tools/` 1
  - `services/platform/src/case-context-discovery/` 6
  - `services/platform/src/case-execution/` 1
  - `services/platform/src/chat/` 1
  - `services/platform/src/chatgpt-exit/` 2
  - `services/platform/src/code-mode-sandbox/` 2
  - `services/platform/src/context/` 1
  - `services/platform/src/context/assembly/` 4
  - `services/platform/src/context/files/` 10
  - `services/platform/src/context/projection/` 1
  - `services/platform/src/control/` 2
  - `services/platform/src/control/routes/` 2
  - `services/platform/src/control/routes/agents/` 2
  - `services/platform/src/cues/` 4
  - `services/platform/src/data/` 5
  - `services/platform/src/data/agent-operations/` 14
  - `services/platform/src/integrations/typesafe/` 9
  - `services/platform/src/jev-features/` 1
  - `services/platform/src/messages/` 11
  - `services/platform/src/model-exit/` 3
  - `services/platform/src/models/` 7
  - `services/platform/src/provider-adapters/` 2
  - `services/platform/src/provider-workflows/` 1
  - `services/platform/src/schedules/` 3
- Tables (36): `agent_area_assignment`, `agent_configuration_proposal`, `agent_definition`, `agent_definition_revision`, `agent_installation`, `agent_installation_governance`, `agent_responsibility_scope`, `case_assignment_pin`, `context_projection`, `cue_binding`, `cue_log`, `cue_subscription`, `escalation_policy`, `file_extraction_budget`, `file_grant_admission`, `file_grant_sync`, `file_projection_outbox`, `file_provider_cursor`, `file_resource_source`, `operational_area`, `organisation_claude_authorization`, `organisation_claude_connection`, `organisation_codex_authorization_attempt`, `organisation_codex_connection`, `organisation_default_workspace`, `organisation_inference_selection`, `organisation_slack_reasoning_effort`, `organisation_workspace`, `schedule_binding`, `schedule_dispatch_receipt`, `skill`, `skill_binding`, `skill_revision`, `workspace_revision`, `workspace_revision_head`, `workspace_revision_receipt`

## foundation/conversation

- Files: 95 in 13 folders
  - `services/platform/src/actors/` 12
  - `services/platform/src/actors/case/` 17
  - `services/platform/src/actors/connector/` 11
  - `services/platform/src/case-context-discovery/` 1
  - `services/platform/src/chat/` 29
  - `services/platform/src/chat/turn/` 1
  - `services/platform/src/control/admission/` 1
  - `services/platform/src/control/routes/` 9
  - `services/platform/src/control/routes/agents/` 2
  - `services/platform/src/data/` 1
  - `services/platform/src/messages/` 1
  - `services/platform/src/projects/` 9
  - `services/platform/src/slack/` 1
- Tables (16): `case_project`, `organisation_default_project`, `portal_chat_conversation_access_operation`, `portal_chat_deletion`, `portal_chat_directory`, `portal_chat_directory_operation`, `portal_chat_directory_project`, `portal_chat_fork`, `portal_conversation`, `portal_conversation_user`, `project`, `project_access_operation`, `project_member`, `project_operation`, `session_turn_access`, `side_case_proposal`

## foundation/tool-handlers

- Files: 7 in 5 folders
  - `services/platform/src/actors/` 3
  - `services/platform/src/actors/session/` 1
  - `services/platform/src/agent-tools/` 1
  - `services/platform/src/agent-tools/files/` 1
  - `services/platform/src/slack/` 1

## foundation/collaboration

- Files: 12 in 2 folders
  - `apps/portal/src/features/collaboration/` 8
  - `services/platform/src/actors/` 4
- Packages: `packages/collaboration`

## areas/brain

- Files: 43 in 10 folders
  - `apps/portal/src/` 2
  - `apps/portal/src/features/brain/` 20
  - `services/platform/src/actors/` 3
  - `services/platform/src/actors/connector/` 1
  - `services/platform/src/case-execution/` 3
  - `services/platform/src/control/routes/` 4
  - `services/platform/src/evals/` 4
  - `services/platform/src/evals/contract/` 1
  - `services/platform/src/memory/` 3
  - `services/platform/src/memory/contract/` 2
- Public files: `apps/portal/src/execution-client.ts`, `apps/portal/src/features/brain/address.ts`, `apps/portal/src/features/brain/api.ts`, `services/platform/src/evals/contract/`, `services/platform/src/evals/scorer.ts`, `services/platform/src/memory/contract/`

## areas/cafe

- Files: 80 in 13 folders
  - `apps/portal/src/features/content-studio/` 2
  - `apps/portal/src/features/menu-boards/` 23
  - `apps/portal/src/features/order-queue/` 2
  - `apps/portal/src/features/register/` 6
  - `apps/portal/src/features/terminals/` 4
  - `services/platform/src/actors/` 10
  - `services/platform/src/agent-tools/commerce/` 2
  - `services/platform/src/agent-tools/drafts/` 5
  - `services/platform/src/cafe/contract/` 5
  - `services/platform/src/commerce/` 3
  - `services/platform/src/control/admission/` 2
  - `services/platform/src/control/routes/` 12
  - `services/platform/src/data/` 4
- Packages: `packages/cafe-control-api`, `packages/menu-board-crdt`, `packages/menu-draft-crdt`
- Tables (3): `cafe_counter_receipt_setting`, `cafe_terminal_assignment`, `screen_pairing`
- Public files: `services/platform/src/cafe/contract/`

## areas/commerce

- Files: 209 in 30 folders
  - `apps/portal/src/` 1
  - `apps/portal/src/features/api-keys/` 2
  - `apps/portal/src/features/bank-payouts/` 2
  - `apps/portal/src/features/checkout-profiles/` 11
  - `apps/portal/src/features/commerce/` 19
  - `apps/portal/src/features/commerce/description-draft/` 3
  - `apps/portal/src/features/commerce/entity-plane/` 8
  - `apps/portal/src/features/ecommerce/` 6
  - `apps/portal/src/features/governed-actions/` 9
  - `apps/portal/src/features/orders/` 3
  - `apps/portal/src/features/payment-accounts/` 2
  - `apps/portal/src/features/payments/` 3
  - `apps/portal/src/features/payouts/` 4
  - `services/platform/src/actors/` 8
  - `services/platform/src/actors/commerce-projection/` 4
  - `services/platform/src/actors/organisation/` 3
  - `services/platform/src/agent-tools/commerce/` 10
  - `services/platform/src/commerce-lab/` 5
  - `services/platform/src/commerce/` 21
  - `services/platform/src/commerce/contract/` 19
  - `services/platform/src/commerce/entity-plane/` 23
  - `services/platform/src/control/` 1
  - `services/platform/src/control/admission/` 1
  - `services/platform/src/control/routes/` 11
  - `services/platform/src/control/routes/agents/` 2
  - `services/platform/src/control/routes/commerce/` 5
  - `services/platform/src/data/` 11
  - `services/platform/src/payout-providers/` 1
  - `services/platform/src/payouts/` 5
  - `services/platform/src/stripe/` 6
- Packages: `packages/commerce-client`, `packages/commerce-contracts`, `packages/commerce-control-api`, `packages/commerce-query-sqlite`, `packages/product-description-crdt`, `services/commerce`
- Tables (13): `campaign_brief`, `commerce_capability_activation`, `commerce_export_preset_publication`, `commerce_lab_organisation`, `commerce_lab_run`, `paid_receipt`, `supplier_destination_revision`, `supplier_payable`, `supplier_payout`, `supplier_payout_attempt`, `supplier_payout_certification`, `supplier_payout_event`, `underclerk_webhook_subscription`
- Public files: `apps/portal/src/features/commerce/entity-plane/api.ts`, `apps/portal/src/features/commerce/operations.ts`, `apps/portal/src/features/commerce/stock-status.ts`, `apps/portal/src/features/governed-actions/commerce.ts`, `packages/commerce-contracts`, `services/platform/src/commerce/contract/`

## areas/devices

- Files: 29 in 6 folders
  - `apps/portal/src/features/devices/` 5
  - `services/platform/src/actors/` 6
  - `services/platform/src/agent-tools/devices/` 4
  - `services/platform/src/control/routes/` 1
  - `services/platform/src/devices/` 9
  - `services/platform/src/devices/contract/` 4
- Tables (7): `device_alert`, `device_alert_setting`, `device_camera_policy`, `device_enrollment`, `device_event`, `device_gateway`, `device_snapshot`
- Public files: `services/platform/src/devices/contract/`

## areas/inbox

- Files: 146 in 19 folders
  - `apps/portal/src/` 1
  - `apps/portal/src/features/email-review/` 2
  - `apps/portal/src/features/mail-inbox/` 25
  - `apps/portal/src/features/mail-setup/` 4
  - `apps/portal/src/pages/` 1
  - `services/platform/src/actors/` 24
  - `services/platform/src/actors/case-inbox/` 3
  - `services/platform/src/actors/inbox-turns/` 3
  - `services/platform/src/actors/organisation/` 2
  - `services/platform/src/agent-tools/channels/` 8
  - `services/platform/src/case-context-discovery/` 1
  - `services/platform/src/control/` 3
  - `services/platform/src/control/admission/` 2
  - `services/platform/src/control/routes/` 10
  - `services/platform/src/control/routes/agents/` 3
  - `services/platform/src/data/` 9
  - `services/platform/src/mail-inbox/` 35
  - `services/platform/src/mail-inbox/contract/` 9
  - `services/platform/src/whatsapp/` 1
- Packages: `packages/email-draft-crdt`, `packages/inbox-control-api`, `packages/mail-reply-crdt`
- Tables (26): `agent_mailbox_binding`, `agent_mailbox_binding_revision`, `contact_endpoint_verification`, `email_mailbox_account`, `email_message_receipt`, `email_operational_attestation`, `email_operational_contact`, `email_operational_proposal_projection`, `email_reply_proposal`, `email_self_test`, `email_sender_account`, `email_thread_case`, `gmail_inference_eligibility`, `mail_assistant_eligibility`, `mail_classification`, `mailbox_ingress_policy`, `mailbox_ingress_policy_revision`, `whatsapp_case_conversation_window`, `whatsapp_delivery_status`, `whatsapp_ingress_policy`, `whatsapp_ingress_policy_revision`, `whatsapp_message_receipt`, `whatsapp_phone_number_account`, `whatsapp_reply_proposal`, `whatsapp_support_binding`, `whatsapp_support_binding_revision`
- Public files: `apps/portal/src/features/email-review/api.ts`, `apps/portal/src/features/email-review/review.tsx`, `apps/portal/src/features/mail-setup/`, `apps/portal/src/pages/agent-mailbox.ts`, `apps/portal/src/whatsapp.ts`, `services/platform/src/mail-inbox/contract/`

## areas/integrations

- Files: 157 in 22 folders
  - `apps/portal/src/` 3
  - `apps/portal/src/features/integrations/` 38
  - `apps/portal/src/features/jev-features/` 3
  - `apps/portal/src/features/vault/` 7
  - `apps/portal/src/pages/` 2
  - `services/platform/src/actors/` 1
  - `services/platform/src/agent-tools/integrations/` 4
  - `services/platform/src/agent-tools/jev/` 4
  - `services/platform/src/control/routes/` 4
  - `services/platform/src/control/routes/custom-connectors/` 4
  - `services/platform/src/control/routes/integrations/` 8
  - `services/platform/src/custom-connectors/` 22
  - `services/platform/src/data/` 1
  - `services/platform/src/external-records/` 2
  - `services/platform/src/gateway/` 5
  - `services/platform/src/integrations/` 1
  - `services/platform/src/integrations/contract/` 15
  - `services/platform/src/jev-features/` 7
  - `services/platform/src/mail/` 1
  - `services/platform/src/provider-adapters/` 8
  - `services/platform/src/provider-lifecycle/` 6
  - `services/platform/src/provider-workflows/` 11
- Tables (8): `credential_rotation`, `custom_connector`, `custom_connector_account_binding`, `custom_connector_revision`, `custom_connector_setup_attempt`, `discord_interaction_install`, `mail_classification_eligibility`, `provider_account_cleanup`
- Public files: `apps/portal/src/features/integrations/archive-confirm.tsx`, `apps/portal/src/features/integrations/connect-consent-dialog.tsx`, `apps/portal/src/features/integrations/connection-dialog.tsx`, `apps/portal/src/features/integrations/custom-connector-api.ts`, `apps/portal/src/features/jev-features/api.ts`, `apps/portal/src/features/jev-features/paid-use.tsx`, `apps/portal/src/integration-catalogue.ts`, `apps/portal/src/provider-onboarding.tsx`, `services/platform/src/integrations/contract/`, `services/platform/src/mail/gmail-oauth.ts`

## areas/kitchen

- Files: 304 in 30 folders
  - `apps/portal/src/features/` 4
  - `apps/portal/src/features/costs/` 15
  - `apps/portal/src/features/production-run/` 57
  - `apps/portal/src/features/production-run/black-sesame/` 3
  - `apps/portal/src/features/production-run/cafe-shift/` 3
  - `apps/portal/src/features/production-run/financier-bake/` 3
  - `apps/portal/src/features/production-run/financier-batter/` 3
  - `apps/portal/src/features/production-run/financier-pack/` 3
  - `apps/portal/src/features/production-run/ginger-tea/` 3
  - `apps/portal/src/features/production-run/latte/` 3
  - `apps/portal/src/features/production-run/linea/` 4
  - `apps/portal/src/features/production-run/pastry-bench/` 5
  - `apps/portal/src/features/production-run/pour-over/` 3
  - `apps/portal/src/features/production-run/shared/` 8
  - `apps/portal/src/features/production-run/siphon/` 3
  - `apps/portal/src/features/recipes/` 3
  - `apps/portal/src/features/workflow-simulator/` 75
  - `apps/portal/src/features/workflow-simulator/docks/` 10
  - `apps/portal/src/features/workflow-simulator/spatial/` 31
  - `services/platform/src/actors/` 9
  - `services/platform/src/agent-tools/bakery/` 4
  - `services/platform/src/agent-tools/costs/` 2
  - `services/platform/src/agent-tools/kitchen/` 14
  - `services/platform/src/commerce/` 3
  - `services/platform/src/commerce/bakery/` 9
  - `services/platform/src/commerce/purchasing/` 1
  - `services/platform/src/control/admission/` 4
  - `services/platform/src/control/routes/` 12
  - `services/platform/src/data/` 1
  - `services/platform/src/kitchen/contract/` 6
- Packages: `packages/bakery-model`, `packages/bakery-workflow`, `packages/costs-sheet-crdt`, `packages/kitchen-control-api`, `packages/production-plan-crdt`, `packages/production-simulation`, `packages/workflow-canvas-crdt`
- Tables (9): `bakery_agent_run_save`, `bakery_agent_scenario_save`, `bakery_cost_plan`, `bakery_cost_product_plan`, `bakery_lot_invoice_cost`, `bakery_surface_effect_delivery`, `bakery_surface_timeline_event`, `bakery_workflow`, `bakery_workflow_revision`
- Public files: `apps/portal/src/features/bakery-browser-context.ts`, `services/platform/src/agent-tools/bakery/surface-result.ts`, `services/platform/src/agent-tools/kitchen/services.ts`, `services/platform/src/kitchen/contract/`

## areas/organisation

- Files: 71 in 12 folders
  - `apps/portal/src/` 2
  - `apps/portal/src/features/access/` 29
  - `apps/portal/src/features/agent-schedules/` 3
  - `apps/portal/src/features/billing/` 1
  - `apps/portal/src/pages/` 12
  - `services/platform/src/account-platform/` 1
  - `services/platform/src/actors/organisation/` 1
  - `services/platform/src/agent-tools/organisation/` 1
  - `services/platform/src/control/` 1
  - `services/platform/src/control/routes/` 4
  - `services/platform/src/data/` 12
  - `services/platform/src/organisation/contract/` 4
- Tables (21): `account_service_invitation_role`, `control_support_role`, `onboarding_reconciliation_run`, `onboarding_support_access_audit`, `onboarding_support_reference`, `operator_configuration_draft`, `organisation_activation_attempt`, `organisation_activation_receipt`, `organisation_activation_step`, `organisation_communication_destination`, `organisation_first_operational_task`, `organisation_harness_erasure`, `organisation_harness_erasure_object`, `organisation_harness_erasure_session`, `organisation_onboarding_selection`, `organisation_readiness_assessment`, `organisation_setup_snapshot`, `organisation_slack_channel`, `provider_account_tombstone`, `provider_manifest`, `user_preferences`
- Public files: `apps/portal/src/features/access/agent-permission-request.tsx`, `apps/portal/src/features/access/api.ts`, `apps/portal/src/features/access/permission-enable.ts`, `apps/portal/src/features/access/permission-required-prompt.tsx`, `apps/portal/src/pages/account-invitation-link.ts`, `apps/portal/src/pages/agent-console-shared.tsx`, `services/platform/src/organisation/contract/`

## areas/shopify

- Files: 22 in 2 folders
  - `services/platform/src/shopify/` 15
  - `services/platform/src/shopify/connector/` 7

## surfaces/docs-site

- Packages: `apps/docs`

## surfaces/email

- Files: 10 in 4 folders
  - `services/platform/src/actors/` 3
  - `services/platform/src/actors/connector/` 4
  - `services/platform/src/gateway/` 1
  - `services/platform/src/mail/` 2

## surfaces/portal

- Files: 155 in 10 folders
  - `apps/portal/src/` 22
  - `apps/portal/src/dev/` 54
  - `apps/portal/src/features/chat/` 36
  - `apps/portal/src/features/integrations/` 1
  - `apps/portal/src/pages/` 1
  - `apps/portal/src/tv/` 2
  - `services/platform/src/chat/` 20
  - `services/platform/src/chat/turn/` 7
  - `services/platform/src/control/routes/` 5
  - `services/platform/src/control/routes/chat/` 7
- Packages: `apps/portal`

## surfaces/slack

- Files: 56 in 8 folders
  - `services/platform/src/actors/` 5
  - `services/platform/src/actors/connector/` 2
  - `services/platform/src/agent-tools/slack/` 4
  - `services/platform/src/control/routes/` 2
  - `services/platform/src/data/` 2
  - `services/platform/src/gateway-routing/` 1
  - `services/platform/src/slack-ingress/` 4
  - `services/platform/src/slack/` 36
- Tables (6): `external_identity_link`, `external_identity_link_challenge`, `slack_conversation_fact`, `slack_dm_organisation_selection`, `slack_message_proposal`, `slack_thread_case_pin`

## surfaces/storefront

- Packages: `apps/storefront`

## surfaces/voice

- Files: 26 in 3 folders
  - `apps/portal/src/features/voice/` 15
  - `services/platform/src/voice/` 10
  - `services/platform/src/voice/engines/` 1
- Tables (3): `voice_confirmation`, `voice_mac`, `voice_transcription_use`

## surfaces/webhooks

- Files: 18 in 4 folders
  - `services/platform/src/` 1
  - `services/platform/src/gateway-routing/` 6
  - `services/platform/src/gateway/` 5
  - `services/platform/src/gateway/admin/` 6

## surfaces/whatsapp

- Files: 8 in 3 folders
  - `services/platform/src/actors/` 2
  - `services/platform/src/actors/connector/` 2
  - `services/platform/src/whatsapp/` 4

## workers/platform

- Files: 21 in 6 folders
  - `services/platform/src/` 6
  - `services/platform/src/actors/` 6
  - `services/platform/src/actors/organisation/` 3
  - `services/platform/src/agent-tools/` 2
  - `services/platform/src/control/` 2
  - `services/platform/src/control/routes/` 2
- Packages: `services/platform`
- Tables (5): `connector`, `install`, `thread_binding`, `thread_file_watch`, `tool_call`

## workers/punter

- Packages: `scripts/punter`
