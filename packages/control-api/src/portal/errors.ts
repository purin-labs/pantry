import { assertNever, isRecord } from "@purin-labs/std";

export type ControlErrorKind =
  | "organisation_create_invalid"
  | "organisation_owner_unverified"
  | "organisation_limit_reached"
  | "organisation_invitation_not_found"
  | "organisation_invitation_email_mismatch"
  | "organisation_invitation_closed"
  | "organisation_invitation_expired"
  | "goal_execution_busy"
  | "goal_revision_conflict"
  | "goal_usage_pending"
  | "configuration_conflict"
  | "session_ended"
  | "forbidden"
  | "workspace_missing"
  | "commerce_action_missing"
  | "commerce_order_has_prepared_lines"
  | "commerce_system_missing"
  | "production_cursor_stale"
  | "production_plan_chat_private"
  | "commerce_revision_conflict"
  | "inventory_receipt_duplicate"
  | "inventory_receipt_invalid"
  | "inventory_count_shortage"
  | "bakery_run_not_found"
  | "bakery_scenario_stale"
  | "bakery_workflow_stale"
  | "bakery_workflow_human_intervention"
  | "bakery_workflow_proposal_closed"
  | "bakery_scenario_invalid"
  | "bakery_agent_save_approval_invalid"
  | "idempotency_key_conflict"
  | "approval_step_up_required"
  | "default_account_replacement_required"
  | "default_account_replacement_invalid"
  | "credential_already_revoked"
  | "replacement_environment_mismatch"
  | "replacement_identity_mismatch"
  | "replacement_validation_failed"
  | "credential_rotation_provider_unsupported"
  | "credential_rotation_conflict"
  | "external_records_credential_invalid"
  | "external_records_access_denied"
  | "external_records_rate_limited"
  | "external_records_unavailable"
  | "provider_configuration_missing"
  | "provider_attempt_open"
  | "codex_device_authorization_unavailable"
  | "codex_sign_in_address_invalid"
  | "codex_authorization_failed"
  | "codex_plan_usage_not_allowed"
  | "codex_sign_in_unavailable"
  | "agent_mailbox_missing"
  | "agent_mailbox_not_processing"
  | "agent_mailbox_check_failed"
  | "agent_mailbox_unassigned"
  | "agent_mailbox_not_paused"
  | "mailbox_sender_link_invalid"
  | "mailbox_sender_supplier_missing"
  | "mailbox_sender_link_changed"
  | "mailbox_sender_link_conflict"
  | "mailbox_sender_link_unavailable"
  | "email_reply_missing"
  | "email_reply_stale"
  | "email_reply_invalidated"
  | "email_reply_expired"
  | "supplier_payout_read_unavailable"
  | "slack_channel_taken"
  | "slack_channel_connection_inactive"
  | "unknown";

type ControlApiProblem = {
  readonly kind: ControlErrorKind;
  readonly message: string;
  readonly supportReference: string | null;
};

export function parseControlApiProblem(raw: unknown): ControlApiProblem {
  const supportReference =
    isRecord(raw) && typeof raw.support_reference === "string"
      ? raw.support_reference
      : null;
  const rawCode =
    isRecord(raw) && typeof raw.error === "string"
      ? raw.error
      : isRecord(raw) && typeof raw.reason_code === "string"
        ? raw.reason_code
        : null;
  const kind = controlErrorKind(rawCode);
  return { kind, message: controlErrorMessage(kind), supportReference };
}

export function controlApiProblemMessage(problem: ControlApiProblem): string {
  return problem.supportReference === null
    ? problem.message
    : `${problem.message} Support reference: ${problem.supportReference}`;
}

function controlErrorKind(code: string | null): ControlErrorKind {
  switch (code) {
    case "goal_execution_running":
    case "chat_goal_execution_busy":
      return "goal_execution_busy";
    case "goal_revision_conflict":
    case "goal_command_conflict":
      return "goal_revision_conflict";
    case "goal_usage_pending":
      return "goal_usage_pending";
    case "production_cursor_stale":
      return "production_cursor_stale";
    case "production_plan_chat_private":
      return "production_plan_chat_private";
    case "configuration_version_conflict":
      return "configuration_conflict";
    case "access_control_revision_conflict":
    case "access_grant_revision_conflict":
    case "capability_policy_revision_conflict":
      return "configuration_conflict";
    case "unauthorized":
    case "account_sign_in_required":
    case "control_session_required":
      return "session_ended";
    case "forbidden":
    case "insufficient_role":
    case "organisation_role_insufficient":
      return "forbidden";
    case "organisation_create_invalid":
    case "organisation_owner_unverified":
    case "organisation_limit_reached":
    case "organisation_invitation_not_found":
    case "organisation_invitation_email_mismatch":
    case "organisation_invitation_closed":
    case "organisation_invitation_expired":
      return code;
    case "organisation_not_found":
      return "workspace_missing";
    case "commerce_action_not_found":
      return "commerce_action_missing";
    case "commerce_action_order_has_prepared_lines":
      return "commerce_order_has_prepared_lines";
    case "commerce_system_missing":
      return "commerce_system_missing";
    case "stale_merchant_revision":
    case "stale_resource_revision":
    case "revision_conflict":
      return "commerce_revision_conflict";
    case "inventory_receipt_already_applied":
      return "inventory_receipt_duplicate";
    case "inventory_count_shortage":
      return "inventory_count_shortage";
    case "inventory_receipt_invalid":
      return "inventory_receipt_invalid";
    case "bakery_run_not_found":
      return "bakery_run_not_found";
    case "bakery_scenario_stale":
      return "bakery_scenario_stale";
    case "bakery_workflow_stale":
      return "bakery_workflow_stale";
    case "bakery_workflow_human_intervention":
      return "bakery_workflow_human_intervention";
    case "bakery_workflow_proposal_closed":
      return "bakery_workflow_proposal_closed";
    case "bakery_scenario_invalid":
    case "bakery_production_scenario_invalid":
      return "bakery_scenario_invalid";
    case "bakery_agent_save_approval_invalid":
      return "bakery_agent_save_approval_invalid";
    case "idempotency_key_conflict":
      return "idempotency_key_conflict";
    case "approval_step_up_required":
      return "approval_step_up_required";
    case "default_account_replacement_required":
      return "default_account_replacement_required";
    case "default_account_replacement_invalid":
      return "default_account_replacement_invalid";
    case "credential_already_revoked":
      return "credential_already_revoked";
    case "replacement_environment_mismatch":
      return "replacement_environment_mismatch";
    case "replacement_identity_mismatch":
      return "replacement_identity_mismatch";
    case "replacement_validation_failed":
      return "replacement_validation_failed";
    case "credential_rotation_provider_unsupported":
      return "credential_rotation_provider_unsupported";
    case "credential_rotation_conflict":
      return "credential_rotation_conflict";
    case "external_records_connection_invalid":
    case "external_records_input_invalid":
    case "external_records_base_required":
    case "external_records_credential_invalid":
      return "external_records_credential_invalid";
    case "external_records_access_denied":
      return "external_records_access_denied";
    case "external_records_rate_limited":
      return "external_records_rate_limited";
    case "external_records_unavailable":
    case "external_records_response_invalid":
    case "external_records_secret_store_failed":
      return "external_records_unavailable";
    case "provider_configuration_missing":
      return "provider_configuration_missing";
    case "provider_attempt_open":
      return "provider_attempt_open";
    case "codex_device_authorization_unavailable":
      return "codex_device_authorization_unavailable";
    case "codex_sign_in_address_invalid":
      return "codex_sign_in_address_invalid";
    case "codex_authorization_failed":
    case "codex_authorization_expired":
      return "codex_authorization_failed";
    case "codex_plan_usage_not_allowed":
      return "codex_plan_usage_not_allowed";
    case "codex_sign_in_unavailable":
      return "codex_sign_in_unavailable";
    case "agent_mailbox_not_connected":
    case "agent_mailbox_missing":
      return "agent_mailbox_missing";
    case "agent_mailbox_not_processing":
      return "agent_mailbox_not_processing";
    case "agent_mailbox_check_failed":
      return "agent_mailbox_check_failed";
    case "agent_mailbox_unassigned":
      return "agent_mailbox_unassigned";
    case "agent_mailbox_not_paused":
      return "agent_mailbox_not_paused";
    case "mailbox_sender_link_invalid":
      return "mailbox_sender_link_invalid";
    case "mailbox_sender_supplier_missing":
      return "mailbox_sender_supplier_missing";
    case "mailbox_sender_link_changed":
      return "mailbox_sender_link_changed";
    case "mailbox_sender_link_conflict":
      return "mailbox_sender_link_conflict";
    case "mailbox_sender_link_unavailable":
      return "mailbox_sender_link_unavailable";
    case "email_reply_not_found":
    case "email_reply_proposal_missing":
      return "email_reply_missing";
    case "email_reply_challenge_stale":
    case "email_reply_approval_stale":
      return "email_reply_stale";
    case "email_reply_invalidated":
      return "email_reply_invalidated";
    case "email_reply_expired":
      return "email_reply_expired";
    case "supplier_payout_read_unavailable":
      return "supplier_payout_read_unavailable";
    case "slack_channel_default_conflict":
      return "slack_channel_taken";
    case "slack_channel_destination_inactive":
      return "slack_channel_connection_inactive";
    default:
      // A refusal for access that no prompt resolved still says so, rather
      // than asking the person to try again.
      return code !== null &&
        (code.endsWith("_forbidden") || code.endsWith("_permission_required"))
        ? "forbidden"
        : "unknown";
  }
}

function controlErrorMessage(kind: ControlErrorKind): string {
  switch (kind) {
    case "organisation_create_invalid":
      return "Enter an organisation name of 1 to 120 characters.";
    case "organisation_owner_unverified":
      return "Your Google account has no verified email. Sign in with a Google account that has a verified email.";
    case "organisation_limit_reached":
      return "You own 5 organisations. A person can own at most 5. Delete one of your organisations, then try again.";
    case "organisation_invitation_not_found":
      return "Pantry cannot find this invitation. Ask the sender for a new link.";
    case "organisation_invitation_email_mismatch":
      return "This invitation is for a different email. Sign in with the Google account that received the invitation.";
    case "organisation_invitation_closed":
      return "This invitation is closed. The sender revoked or replaced it, or another person accepted it. Ask the sender for a new link.";
    case "organisation_invitation_expired":
      return "This invitation expired. Ask the sender for a new link.";
    case "goal_execution_busy":
      return "Wait for the current turn to finish, then refresh the goal and try again.";
    case "goal_revision_conflict":
      return "The goal changed. Review its latest state before saving again.";
    case "goal_usage_pending":
      return "Model usage is unresolved. Refresh the goal after usage is settled.";
    case "production_cursor_stale":
      return "Requests changed while loading. Refresh requests to continue.";
    case "production_plan_chat_private":
      return "This chat is private. Share it in a Project first, then share it with the plan.";
    case "configuration_conflict":
      return "This workspace changed in another session. Refresh and try again.";
    case "session_ended":
      return "Your session has ended. Sign in and try again.";
    case "forbidden":
      return "You do not have permission to do this. Ask an owner or admin of this workspace.";
    case "workspace_missing":
      return "This workspace is no longer available.";
    case "commerce_action_missing":
      return "This proposed change is no longer available. Refresh Operations.";
    case "commerce_order_has_prepared_lines":
      return "An item of this order is already made, so the order cannot be cancelled. No money moved.";
    case "commerce_system_missing":
      return "Connect a commerce system before continuing.";
    case "bakery_workflow_stale":
      return "Another person applied a newer revision of this workflow.";
    case "bakery_workflow_human_intervention":
      return "A person changed the same steps in the draft.";
    case "bakery_workflow_proposal_closed":
      return "This proposal is already closed.";
    case "commerce_revision_conflict":
      return "This commerce record changed in another session. Review the latest value before retrying.";
    case "inventory_count_shortage":
      return "The count is below reserved stock. Resolve the affected reservations before applying this count.";
    case "inventory_receipt_duplicate":
      return "This receipt line is already recorded. Close the dialog and review the updated stock.";
    case "inventory_receipt_invalid":
      return "Review the receipt quantity, lot and expiry before recording the delivery.";
    case "bakery_run_not_found":
      return "This saved run could not be found.";
    case "bakery_scenario_stale":
      return "The source procedure changed. Reload it, review your inputs, and prepare a new scenario copy.";
    case "bakery_scenario_invalid":
      return "Review the scenario inputs and assignments before preparing a new copy.";
    case "bakery_agent_save_approval_invalid":
      return "This save approval is unavailable or expired. Dismiss it and ask the agent to prepare a new copy.";
    case "idempotency_key_conflict":
      return "This request has already been handled. Refresh and try again.";
    case "approval_step_up_required":
      return "Confirm your identity to continue.";
    case "default_account_replacement_required":
      return "Choose a replacement default account before revoking this credential.";
    case "default_account_replacement_invalid":
      return "That replacement account cannot take over as the default account. Choose an active account for the same provider.";
    case "credential_already_revoked":
      return "This credential has already been revoked.";
    case "replacement_environment_mismatch":
      return "The new key belongs to a different environment. Enter a key that matches this account's environment.";
    case "replacement_identity_mismatch":
      return "The new key belongs to a different account. Enter a key issued for this connected account.";
    case "replacement_validation_failed":
      return "The provider rejected the new key. Check the value and try again.";
    case "credential_rotation_provider_unsupported":
      return "This connection does not accept a pasted key. Use Reconnect to refresh its access.";
    case "credential_rotation_conflict":
      return "Another key rotation for this account is still in progress. Wait for it to finish, then try again.";
    case "external_records_credential_invalid":
      return "The provider rejected these connection details. Check the token and resource ID, then try again.";
    case "external_records_access_denied":
      return "This token does not have access to the requested resource. Update its permissions and try again.";
    case "external_records_rate_limited":
      return "The provider is receiving too many requests. Wait a moment, then try again.";
    case "external_records_unavailable":
      return "The provider could not verify this connection. Try again shortly.";
    case "provider_attempt_open":
      return "An earlier connection to this service is still open. Finish it in its window, or wait 10 minutes and try again.";
    case "provider_configuration_missing":
      return "This integration is unavailable. Ask your Seams Pantry administrator to configure it, then try again.";
    case "codex_device_authorization_unavailable":
      return "Enable device code login in ChatGPT security settings or ask your OpenAI workspace admin to allow it, then try again.";
    case "codex_sign_in_address_invalid":
      return "This is not the address of this ChatGPT sign-in. Copy the full address that starts with http://127.0.0.1:1455/auth/callback, then paste it again.";
    case "codex_authorization_failed":
      return "ChatGPT did not complete the sign-in. Select Connect ChatGPT to start again.";
    case "codex_plan_usage_not_allowed":
      return "ChatGPT did not allow Seams Pantry to use your plan. Select Connect ChatGPT and allow plan usage.";
    case "codex_sign_in_unavailable":
      return "OpenAI did not answer. Paste the same address again in a moment.";
    case "agent_mailbox_not_processing":
      return "This mailbox is off. Turn it on to let its agent read new mail.";
    case "agent_mailbox_check_failed":
      return "Pantry could not check Gmail for new mail. Try again.";
    case "agent_mailbox_missing":
      return "This mailbox is not connected to the workspace.";
    case "agent_mailbox_unassigned":
      return "Assign an agent to this mailbox before enabling processing.";
    case "agent_mailbox_not_paused":
      return "Mailbox processing is not paused right now. Refresh to see the current state.";
    case "mailbox_sender_link_invalid":
      return "This sender cannot be linked. Its address is not valid or belongs to this mailbox.";
    case "mailbox_sender_supplier_missing":
      return "This supplier no longer exists. Choose another supplier.";
    case "mailbox_sender_link_changed":
      return "The supplier link changed in another session. Refresh and try again.";
    case "mailbox_sender_link_conflict":
      return "Another contact record already verifies this address, so the Inbox cannot change its link.";
    case "mailbox_sender_link_unavailable":
      return "Pantry could not read or change the supplier link. Try again.";
    case "email_reply_missing":
      return "This reply proposal is no longer available. The draft may have been deleted in Gmail.";
    case "email_reply_stale":
      return "This reply changed since you previewed it. Review the latest version and approve again.";
    case "email_reply_invalidated":
      return "The draft's recipient, subject, thread, or attachments changed in Gmail, which cancels this proposal.";
    case "email_reply_expired":
      return "This reply proposal expired before it was approved.";
    case "supplier_payout_read_unavailable":
      return "You do not have permission to read supplier payouts.";
    case "slack_channel_taken":
      return "Another Seams Pantry workspace already posts in this channel. Choose another channel, or remove it from that workspace first.";
    case "slack_channel_connection_inactive":
      return "This Slack workspace is not connected. Connect it again, then add the channel.";
    case "unknown":
      return "Pantry could not complete this request. Try again.";
    default:
      return assertNever(kind, "Unhandled control error kind");
  }
}
