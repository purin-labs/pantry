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
tables that the module owns; only the owner writes a table. "Public files"
gives the contract of an area: the files and folders that another area may
import. A module with no line for one of these has none.

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
- Tables (36): `agent_area_assignment`, `agent_configuration_proposal`, `agent_definition`, `agent_definition_revision`, `agent_installation`, `agent_installation_governance`, `agent_responsibility_scope`, `case_assignment_pin`, `context_projection`, `cue_binding`, `cue_log`, `cue_subscription`, `escalation_policy`, `file_extraction_budget`, `file_grant_admission`, `file_grant_sync`, `file_projection_outbox`, `file_provider_cursor`, `file_resource_source`, `operational_area`, `organisation_claude_authorization`, `organisation_claude_connection`, `organisation_codex_authorization_attempt`, `organisation_codex_connection`, `organisation_default_workspace`, `organisation_inference_selection`, `organisation_slack_reasoning_effort`, `organisation_workspace`, `schedule_binding`, `schedule_dispatch_receipt`, `skill`, `skill_binding`, `skill_revision`, `workspace_revision`, `workspace_revision_head`, `workspace_revision_receipt`

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

- Folders: 10
  - `areas/brain/server/actors/`
  - `areas/brain/server/actors/connector/`
  - `areas/brain/server/case-execution/`
  - `areas/brain/server/control/routes/`
  - `areas/brain/server/evals/`
  - `areas/brain/server/evals/contract/`
  - `areas/brain/server/memory/`
  - `areas/brain/server/memory/contract/`
  - `areas/brain/ui/`
  - `areas/brain/ui/features/brain/`
- Packages: `areas/brain`
- Public files: `areas/brain/server/evals/contract/`, `areas/brain/server/evals/scorer.ts`, `areas/brain/server/memory/contract/`, `areas/brain/ui/execution-client.ts`, `areas/brain/ui/features/brain/address.ts`, `areas/brain/ui/features/brain/api.ts`

## areas/cafe

- Folders: 13
  - `apps/portal/src/features/content-studio/`
  - `apps/portal/src/features/menu-boards/`
  - `apps/portal/src/features/order-queue/`
  - `apps/portal/src/features/register/`
  - `apps/portal/src/features/terminals/`
  - `services/platform/src/actors/`
  - `services/platform/src/agent-tools/commerce/`
  - `services/platform/src/agent-tools/drafts/`
  - `services/platform/src/cafe/contract/`
  - `services/platform/src/commerce/`
  - `services/platform/src/control/admission/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/data/`
- Packages: `packages/cafe-control-api`, `packages/menu-board-crdt`, `packages/menu-draft-crdt`
- Tables (3): `cafe_counter_receipt_setting`, `cafe_terminal_assignment`, `screen_pairing`
- Public files: `services/platform/src/cafe/contract/`

## areas/commerce

- Folders: 30
  - `apps/portal/src/`
  - `apps/portal/src/features/api-keys/`
  - `apps/portal/src/features/bank-payouts/`
  - `apps/portal/src/features/checkout-profiles/`
  - `apps/portal/src/features/commerce/`
  - `apps/portal/src/features/commerce/description-draft/`
  - `apps/portal/src/features/commerce/entity-plane/`
  - `apps/portal/src/features/ecommerce/`
  - `apps/portal/src/features/governed-actions/`
  - `apps/portal/src/features/orders/`
  - `apps/portal/src/features/payment-accounts/`
  - `apps/portal/src/features/payments/`
  - `apps/portal/src/features/payouts/`
  - `services/platform/src/actors/`
  - `services/platform/src/actors/commerce-projection/`
  - `services/platform/src/actors/organisation/`
  - `services/platform/src/agent-tools/commerce/`
  - `services/platform/src/commerce-lab/`
  - `services/platform/src/commerce/`
  - `services/platform/src/commerce/contract/`
  - `services/platform/src/commerce/entity-plane/`
  - `services/platform/src/control/`
  - `services/platform/src/control/admission/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/control/routes/agents/`
  - `services/platform/src/control/routes/commerce/`
  - `services/platform/src/data/`
  - `services/platform/src/payout-providers/`
  - `services/platform/src/payouts/`
  - `services/platform/src/stripe/`
- Packages: `packages/commerce-client`, `packages/commerce-contracts`, `packages/commerce-control-api`, `packages/commerce-query-sqlite`, `packages/product-description-crdt`, `services/commerce`
- Tables (13): `campaign_brief`, `commerce_capability_activation`, `commerce_export_preset_publication`, `commerce_lab_organisation`, `commerce_lab_run`, `commerce_webhook_subscription`, `paid_receipt`, `supplier_destination_revision`, `supplier_payable`, `supplier_payout`, `supplier_payout_attempt`, `supplier_payout_certification`, `supplier_payout_event`
- Public files: `apps/portal/src/features/commerce/description-draft/styles.css`, `apps/portal/src/features/commerce/entity-plane/api.ts`, `apps/portal/src/features/commerce/operations.ts`, `apps/portal/src/features/commerce/stock-status.ts`, `apps/portal/src/features/governed-actions/commerce.ts`, `apps/portal/src/features/governed-actions/decision-labels.ts`, `packages/commerce-contracts`, `services/platform/src/commerce/contract/`

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

## areas/inbox

- Folders: 19
  - `apps/portal/src/`
  - `apps/portal/src/features/email-review/`
  - `apps/portal/src/features/mail-inbox/`
  - `apps/portal/src/features/mail-setup/`
  - `apps/portal/src/pages/`
  - `services/platform/src/actors/`
  - `services/platform/src/actors/case-inbox/`
  - `services/platform/src/actors/inbox-turns/`
  - `services/platform/src/actors/organisation/`
  - `services/platform/src/agent-tools/channels/`
  - `services/platform/src/case-context-discovery/`
  - `services/platform/src/control/`
  - `services/platform/src/control/admission/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/control/routes/agents/`
  - `services/platform/src/data/`
  - `services/platform/src/mail-inbox/`
  - `services/platform/src/mail-inbox/contract/`
  - `services/platform/src/whatsapp/`
- Packages: `packages/email-draft-crdt`, `packages/inbox-control-api`, `packages/mail-reply-crdt`
- Tables (26): `agent_mailbox_binding`, `agent_mailbox_binding_revision`, `contact_endpoint_verification`, `email_mailbox_account`, `email_message_receipt`, `email_operational_attestation`, `email_operational_contact`, `email_operational_proposal_projection`, `email_reply_proposal`, `email_self_test`, `email_sender_account`, `email_thread_case`, `gmail_inference_eligibility`, `mail_assistant_eligibility`, `mail_classification`, `mailbox_ingress_policy`, `mailbox_ingress_policy_revision`, `whatsapp_case_conversation_window`, `whatsapp_delivery_status`, `whatsapp_ingress_policy`, `whatsapp_ingress_policy_revision`, `whatsapp_message_receipt`, `whatsapp_phone_number_account`, `whatsapp_reply_proposal`, `whatsapp_support_binding`, `whatsapp_support_binding_revision`
- Public files: `apps/portal/src/features/email-review/api.ts`, `apps/portal/src/features/email-review/decision-labels.ts`, `apps/portal/src/features/email-review/review.tsx`, `apps/portal/src/features/mail-setup/`, `apps/portal/src/pages/agent-mailbox.ts`, `apps/portal/src/whatsapp.ts`, `services/platform/src/mail-inbox/contract/`

## areas/integrations

- Folders: 22
  - `apps/portal/src/`
  - `apps/portal/src/features/integrations/`
  - `apps/portal/src/features/jev-features/`
  - `apps/portal/src/features/vault/`
  - `apps/portal/src/pages/`
  - `services/platform/src/actors/`
  - `services/platform/src/agent-tools/integrations/`
  - `services/platform/src/agent-tools/jev/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/control/routes/custom-connectors/`
  - `services/platform/src/control/routes/integrations/`
  - `services/platform/src/custom-connectors/`
  - `services/platform/src/data/`
  - `services/platform/src/external-records/`
  - `services/platform/src/gateway/`
  - `services/platform/src/integrations/`
  - `services/platform/src/integrations/contract/`
  - `services/platform/src/jev-features/`
  - `services/platform/src/mail/`
  - `services/platform/src/provider-adapters/`
  - `services/platform/src/provider-lifecycle/`
  - `services/platform/src/provider-workflows/`
- Tables (8): `credential_rotation`, `custom_connector`, `custom_connector_account_binding`, `custom_connector_revision`, `custom_connector_setup_attempt`, `discord_interaction_install`, `mail_classification_eligibility`, `provider_account_cleanup`
- Public files: `apps/portal/src/features/integrations/archive-confirm.tsx`, `apps/portal/src/features/integrations/connect-consent-dialog.tsx`, `apps/portal/src/features/integrations/connection-dialog.tsx`, `apps/portal/src/features/integrations/custom-connector-api.ts`, `apps/portal/src/features/jev-features/api.ts`, `apps/portal/src/features/jev-features/paid-use.tsx`, `apps/portal/src/features/jev-features/styles.css`, `apps/portal/src/features/vault/styles.css`, `apps/portal/src/integration-catalogue.ts`, `apps/portal/src/provider-onboarding.tsx`, `services/platform/src/integrations/contract/`, `services/platform/src/mail/gmail-oauth.ts`

## areas/kitchen

- Folders: 32
  - `apps/portal/src/features/`
  - `apps/portal/src/features/bakes/`
  - `apps/portal/src/features/costs/`
  - `apps/portal/src/features/production-run/`
  - `apps/portal/src/features/production-run/black-sesame/`
  - `apps/portal/src/features/production-run/cafe-shift/`
  - `apps/portal/src/features/production-run/financier-bake/`
  - `apps/portal/src/features/production-run/financier-batter/`
  - `apps/portal/src/features/production-run/financier-pack/`
  - `apps/portal/src/features/production-run/ginger-tea/`
  - `apps/portal/src/features/production-run/latte/`
  - `apps/portal/src/features/production-run/linea/`
  - `apps/portal/src/features/production-run/pastry-bench/`
  - `apps/portal/src/features/production-run/pour-over/`
  - `apps/portal/src/features/production-run/shared/`
  - `apps/portal/src/features/production-run/siphon/`
  - `apps/portal/src/features/recipes/`
  - `apps/portal/src/features/workflow-simulator/`
  - `apps/portal/src/features/workflow-simulator/docks/`
  - `apps/portal/src/features/workflow-simulator/spatial/`
  - `services/platform/src/actors/`
  - `services/platform/src/agent-tools/bakery/`
  - `services/platform/src/agent-tools/costs/`
  - `services/platform/src/agent-tools/kitchen/`
  - `services/platform/src/commerce/`
  - `services/platform/src/commerce/bakery/`
  - `services/platform/src/commerce/purchasing/`
  - `services/platform/src/control/admission/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/data/`
  - `services/platform/src/kitchen/bakes/`
  - `services/platform/src/kitchen/contract/`
- Packages: `packages/bakery-model`, `packages/bakery-workflow`, `packages/costs-sheet-crdt`, `packages/kitchen-control-api`, `packages/production-plan-crdt`, `packages/production-simulation`, `packages/workflow-canvas-crdt`
- Tables (13): `bake_authority`, `bake_proposal`, `bake_run`, `bake_stock_level`, `bakery_agent_run_save`, `bakery_agent_scenario_save`, `bakery_cost_plan`, `bakery_cost_product_plan`, `bakery_lot_invoice_cost`, `bakery_surface_effect_delivery`, `bakery_surface_timeline_event`, `bakery_workflow`, `bakery_workflow_revision`
- Public files: `apps/portal/src/features/bakery-browser-context.ts`, `services/platform/src/agent-tools/bakery/surface-result.ts`, `services/platform/src/agent-tools/kitchen/services.ts`, `services/platform/src/kitchen/contract/`

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
- Public files: `areas/organisation/server/contract/`, `areas/organisation/ui/features/access/agent-permission-request.tsx`, `areas/organisation/ui/features/access/api.ts`, `areas/organisation/ui/features/access/permission-enable.ts`, `areas/organisation/ui/features/access/permission-required-prompt.tsx`, `areas/organisation/ui/pages/account-invitation-link.ts`, `areas/organisation/ui/pages/agent-console-shared.tsx`

## areas/shopify

- Folders: 2
  - `services/platform/src/shopify/`
  - `services/platform/src/shopify/connector/`

## surfaces/docs-site

- Packages: `apps/docs`

## surfaces/email

- Folders: 4
  - `services/platform/src/actors/`
  - `services/platform/src/actors/connector/`
  - `services/platform/src/gateway/`
  - `services/platform/src/mail/`

## surfaces/portal

- Folders: 10
  - `apps/portal/src/`
  - `apps/portal/src/dev/`
  - `apps/portal/src/features/chat/`
  - `apps/portal/src/features/integrations/`
  - `apps/portal/src/pages/`
  - `apps/portal/src/tv/`
  - `services/platform/src/chat/`
  - `services/platform/src/chat/turn/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/control/routes/chat/`
- Packages: `apps/portal`

## surfaces/slack

- Folders: 8
  - `services/platform/src/actors/`
  - `services/platform/src/actors/connector/`
  - `services/platform/src/agent-tools/slack/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/data/`
  - `services/platform/src/gateway-routing/`
  - `services/platform/src/slack-ingress/`
  - `services/platform/src/slack/`
- Tables (6): `external_identity_link`, `external_identity_link_challenge`, `slack_conversation_fact`, `slack_dm_organisation_selection`, `slack_message_proposal`, `slack_thread_case_pin`

## surfaces/storefront

- Packages: `apps/storefront`

## surfaces/voice

- Folders: 3
  - `apps/portal/src/features/voice/`
  - `services/platform/src/voice/`
  - `services/platform/src/voice/engines/`
- Tables (3): `voice_confirmation`, `voice_mac`, `voice_transcription_use`

## surfaces/webhooks

- Folders: 4
  - `services/platform/src/`
  - `services/platform/src/gateway-routing/`
  - `services/platform/src/gateway/`
  - `services/platform/src/gateway/admin/`

## surfaces/whatsapp

- Folders: 3
  - `services/platform/src/actors/`
  - `services/platform/src/actors/connector/`
  - `services/platform/src/whatsapp/`

## workers/platform

- Folders: 10
  - `services/platform/src/`
  - `services/platform/src/actors/`
  - `services/platform/src/actors/organisation/`
  - `services/platform/src/agent-tools/`
  - `services/platform/src/chatgpt-exit/`
  - `services/platform/src/code-mode-sandbox/`
  - `services/platform/src/control/`
  - `services/platform/src/control/routes/`
  - `services/platform/src/model-exit/`
  - `services/platform/src/vault-onepassword/`
- Packages: `services/platform`
- Tables (5): `connector`, `install`, `thread_binding`, `thread_file_watch`, `tool_call`

## workers/punter

- Packages: `scripts/punter`
