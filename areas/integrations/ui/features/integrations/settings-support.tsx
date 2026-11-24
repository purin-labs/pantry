import type { OnboardingSelectedResource } from "@purin-labs/contracts";
import React from "react";
import { type StatusChipStatus } from "@purin-labs/ui/page-components";
import type { WhatsAppConnectionActionState } from "../../pages/whatsapp";
import {
  MutationLedger,
  sameOrganisationMutation,
  type MutationProvider,
  type OrganisationMutation,
} from "@purin-labs/control/portal/mutation-state";
import type { ProviderConnectionState } from "../../provider-onboarding";
import { formatLifecycle } from "@purin-labs/ui/formatting";
import type { Provider } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { loadOnePasswordIntegrationPanel } from "./integrations-page";
import type { CapabilityProfile, ControlRole, IntegrationAccount, IntegrationLifecycle, OrganisationInvitation, OrganisationMember, SetupSelection } from "@purin-labs/control-api/portal/settings";
import type { PendingProviderAuthorization, SettingsMouseHandler, SettingsMutationFeedback, SetupFeedback, SetupFormDefaults } from "./settings-types";

export const OnePasswordIntegrationPanel = React.lazy(loadOnePasswordIntegrationPanel);

/** The element that takes focus when the dialog moves between its two views. */
export const GMAIL_VIEW_FOCUS_ID = "gmail-mailbox-view";

export function renderSetupFeedback(feedback: SetupFeedback): React.ReactNode {
  switch (feedback.kind) {
    case "idle":
      return null;
    case "success":
      return (
        <p className="notice-text setup-feedback" role="status">
          {feedback.message}
        </p>
      );
    case "error":
      return feedback.field === "form" ? (
        <p
          id="setup-form-error"
          className="error-text setup-feedback"
          role="alert"
        >
          {feedback.message}
        </p>
      ) : null;
    default:
      return assertNever(feedback, "Unexpected settings state");
  }
}

export function setupFormHasError(feedback: SetupFeedback): boolean {
  return feedback.kind === "error" && feedback.field === "form";
}

export function setupFieldHasError(
  feedback: SetupFeedback,
  field: "workspace" | "channel",
): boolean {
  return feedback.kind === "error" && feedback.field === field;
}

export function renderSetupFieldError(
  feedback: SetupFeedback,
  field: "workspace" | "channel",
  id: string,
): React.ReactNode {
  if (feedback.kind !== "error" || feedback.field !== field) return null;
  return (
    <span id={id} className="error-text" role="alert">
      {feedback.message}
    </span>
  );
}

export function renderShopifyCommerceChoice(
  select: SettingsMouseHandler,
  mutations: MutationLedger,
  account: IntegrationAccount,
): React.ReactNode {
  const mutation: OrganisationMutation = {
    kind: "select_commerce",
    integrationAccountId: account.integrationAccountId,
  };
  return (
    <button
      type="button"
      key={account.integrationAccountId}
      data-account-id={account.integrationAccountId}
      onClick={select}
      disabled={mutationBlocked(mutations, mutation)}
    >
      Use {account.displayName}
    </button>
  );
}

function renderSelectedResource(resource: OnboardingSelectedResource): string {
  return resource.display_label;
}

export function formatSelectedResource(resource: OnboardingSelectedResource): string {
  return renderSelectedResource(resource);
}

export function integrationLifecycleStatus(
  lifecycle: IntegrationLifecycle,
): StatusChipStatus {
  switch (lifecycle) {
    case "active":
      return { kind: "success", label: "Connected" };
    case "degraded":
      return { kind: "warning", label: "Needs attention" };
    case "reauth_required":
      return { kind: "warning", label: "Reconnect needed" };
    case "connecting":
    case "pending_activation":
      return { kind: "info", label: formatLifecycle(lifecycle) };
    case "disabled":
      return { kind: "neutral", label: "Disabled" };
    case "revoked":
      return { kind: "danger", label: "Revoked" };
    default:
      return assertNever(lifecycle, "Unexpected settings state");
  }
}

export function formatControlRole(role: ControlRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Codes with no entry here never reach the page: they are logged and toasted
 * instead, so the checklist only ever shows sentences it can stand behind.
 */
export const BLOCKER_COPY: Readonly<Record<string, string>> = {
  owner_missing: "Assign an active workspace owner.",
  communication_connection_missing: "Connect Slack.",
  communication_destination_missing: "Choose a Slack channel.",
  commerce_system_missing: "Choose Purin Checkout or Shopify.",
  credential_unresolved: "Reconnect the affected service.",
  webhook_unhealthy: "Reconnect the affected service so updates can resume.",
  policy_snapshot_missing: "Save your Slack update settings.",
  cue_snapshot_missing: "Save your Slack update settings.",
  readiness_not_evaluated:
    "Purin Pantry has not finished checking this workspace yet.",
  environment_conflict:
    "A connected service is a test account while this workspace runs live, or the reverse. Disconnect it, then reconnect with the matching account.",
  placement_missing:
    "Purin Pantry needs to repair this workspace before it can start. Contact support if this persists.",
};

/**
 * Providers whose connection is repaired by running their authorization
 * again. Each of them accepts a reconnect from the platform's existing-account
 * start route; WhatsApp numbers repair from their own card instead.
 */
export function reconnectableProvider(
  value: string,
): Exclude<Provider, "whatsapp"> | null {
  switch (value) {
    case "slack":
    case "square":
    case "stripe":
    case "shopify":
    case "airtable":
    case "notion":
    case "dropbox":
    case "google_drive":
    case "gmail":
      return value;
    default:
      return null;
  }
}

export function isAirtableAccount(account: IntegrationAccount): boolean {
  return account.provider === "airtable";
}

export function isGmailAccount(account: IntegrationAccount): boolean {
  return account.provider === "gmail";
}

export function isFullMailboxGmailAccount(account: IntegrationAccount): boolean {
  return (
    isGmailAccount(account) && account.capabilities.includes("mailbox.ingress")
  );
}

export function isSendOnlyGmailAccount(account: IntegrationAccount): boolean {
  return (
    isGmailAccount(account) &&
    account.capabilities.includes("email.operational.propose") &&
    !isFullMailboxGmailAccount(account)
  );
}

export function isDropboxAccount(account: IntegrationAccount): boolean {
  return account.provider === "dropbox";
}

export function isGoogleDriveAccount(account: IntegrationAccount): boolean {
  return account.provider === "google_drive";
}

export function isNotionAccount(account: IntegrationAccount): boolean {
  return account.provider === "notion";
}

export function isWhatsAppAccount(account: IntegrationAccount): boolean {
  return account.provider === "whatsapp";
}

export function isShopifyAccount(account: IntegrationAccount): boolean {
  return account.provider === "shopify";
}

export function isSquareAccount(account: IntegrationAccount): boolean {
  return account.provider === "square";
}

export function isStripeAccount(account: IntegrationAccount): boolean {
  return account.provider === "stripe";
}

export function isSlackAccount(account: IntegrationAccount): boolean {
  return account.provider === "slack";
}

export function isActiveIntegrationAccount(account: IntegrationAccount): boolean {
  return account.lifecycle.kind === "active";
}

export function integrationAccountIsConnected(account: IntegrationAccount): boolean {
  switch (account.lifecycle.kind) {
    case "connecting":
    case "pending_activation":
    case "active":
    case "degraded":
    case "reauth_required":
      return true;
    case "disabled":
    case "revoked":
      return false;
    default:
      return assertNever(account.lifecycle, "Unexpected settings state");
  }
}

export function isOwnerMember(member: OrganisationMember): boolean {
  return member.role === "owner";
}

export function isPendingInvitation(
  invitation: OrganisationInvitation,
): invitation is Variant<OrganisationInvitation, "pending"> {
  return invitation.kind === "pending";
}

export function renderCommerceConfigurationFeedback(
  feedback: SettingsMutationFeedback,
): React.ReactNode {
  if (feedback === null) return null;
  switch (feedback.mutation.kind) {
    case "select_commerce":
    case "provision_commerce":
      return (
        <p className="error-text" role="alert">
          {feedback.message}
        </p>
      );
    default:
      return null;
  }
}

export function renderMutationFeedback(
  feedback: SettingsMutationFeedback,
  mutation: OrganisationMutation,
): React.ReactNode {
  if (
    feedback === null ||
    !sameOrganisationMutation(feedback.mutation, mutation)
  )
    return null;
  if (feedback.link !== undefined) {
    return (
      <p className="notice-text" role="status">
        {feedback.message}{" "}
        <a href={feedback.link.href} referrerPolicy="no-referrer">
          {feedback.link.label}
        </a>
      </p>
    );
  }
  return (
    <p className="error-text" role="alert">
      {feedback.message}
    </p>
  );
}

export function mutationFeedbackMessage(
  feedback: SettingsMutationFeedback,
  mutation: OrganisationMutation,
): string | null {
  return feedback !== null &&
    sameOrganisationMutation(feedback.mutation, mutation)
    ? feedback.message
    : null;
}

export function mutationBlocked(
  mutations: MutationLedger,
  mutation: OrganisationMutation,
): boolean {
  return mutations.conflict(mutation) !== null;
}

export function providerConnectionState(
  mutations: MutationLedger,
  pendingAuthorization: PendingProviderAuthorization | null,
  feedback: SettingsMutationFeedback,
  provider: MutationProvider,
): ProviderConnectionState {
  const mutation: OrganisationMutation = { kind: "connect_provider", provider };
  if (mutationBlocked(mutations, mutation)) return { kind: "opening" };
  if (
    pendingAuthorization !== null &&
    pendingAuthorization.kind === "connect" &&
    pendingAuthorization.provider === provider
  ) {
    return { kind: "waiting" };
  }
  const message = mutationFeedbackMessage(feedback, mutation);
  return message === null ? { kind: "idle" } : { kind: "failed", message };
}

export function providerConnectionBusy(
  mutations: MutationLedger,
  pendingAuthorization: PendingProviderAuthorization | null,
  provider: MutationProvider,
): boolean {
  const state = providerConnectionState(
    mutations,
    pendingAuthorization,
    null,
    provider,
  );
  return state.kind === "opening" || state.kind === "waiting";
}

export function whatsappConnectionActionState(
  mutations: MutationLedger,
  pendingAuthorization: PendingProviderAuthorization | null,
  feedback: SettingsMutationFeedback,
): WhatsAppConnectionActionState {
  return providerConnectionState(
    mutations,
    pendingAuthorization,
    feedback,
    "whatsapp",
  );
}

export function integrationAccountBusy(
  mutations: MutationLedger,
  pendingAuthorization: PendingProviderAuthorization | null,
  integrationAccountId: string,
): boolean {
  return (
    mutationBlocked(mutations, {
      kind: "integration_account",
      integrationAccountId,
    }) ||
    awaitingAccountAuthorization(pendingAuthorization, integrationAccountId)
  );
}

export function awaitingAccountAuthorization(
  pendingAuthorization: PendingProviderAuthorization | null,
  integrationAccountId: string,
): boolean {
  return (
    pendingAuthorization !== null &&
    pendingAuthorization.kind === "existing_account" &&
    pendingAuthorization.integrationAccountId === integrationAccountId
  );
}

export function isMemberMutation(mutations: MutationLedger, userId: string): boolean {
  return mutationBlocked(mutations, { kind: "member", userId });
}

export function isInvitationMutation(
  mutations: MutationLedger,
  invitationId: string,
): boolean {
  return mutationBlocked(mutations, { kind: "invitation", invitationId });
}

export function readCapabilityProfile(
  raw: FormDataEntryValue | null,
): CapabilityProfile | null {
  return typeof raw === "string" && isCapabilityProfile(raw) ? raw : null;
}

export function readCuePresetId(
  raw: FormDataEntryValue | null,
): SetupFormDefaults["cuePresetId"] | null {
  return typeof raw === "string" && isCuePresetId(raw) ? raw : null;
}

export function readControlRole(raw: string): ControlRole | null {
  return isControlRole(raw) ? raw : null;
}

export function readAssignableControlRole(
  raw: FormDataEntryValue | null,
): Exclude<ControlRole, "owner"> | null {
  return typeof raw === "string" && isAssignableControlRole(raw) ? raw : null;
}

function isCapabilityProfile(raw: string): raw is CapabilityProfile {
  return raw === "read_and_propose" || raw === "approved_provider_writes";
}

function isCuePresetId(raw: string): raw is SetupFormDefaults["cuePresetId"] {
  return (
    raw === "observe_commerce" ||
    raw === "commerce_operator" ||
    raw === "proactive_triage"
  );
}

function isControlRole(raw: string): raw is ControlRole {
  return (
    raw === "owner" || raw === "admin" || raw === "operator" || raw === "viewer"
  );
}

function isAssignableControlRole(
  raw: string,
): raw is Exclude<ControlRole, "owner"> {
  return raw === "admin" || raw === "operator" || raw === "viewer";
}

type SetupSelectionResult =
  | { readonly ok: true; readonly value: SetupSelection }
  | {
      readonly ok: false;
      readonly error: {
        readonly field: "workspace" | "channel";
        readonly message: string;
      };
    };

export function buildSetupSelection(
  form: FormData,
  capabilityProfile: CapabilityProfile,
  cuePresetId: SetupFormDefaults["cuePresetId"],
): SetupSelectionResult {
  const workspaceId = form.get("workspaceId");
  const channelId = form.get("channelId");
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    return {
      ok: false,
      error: {
        field: "workspace",
        message: "Select a connected Slack workspace.",
      },
    };
  }
  if (typeof channelId !== "string" || channelId.trim().length === 0) {
    return {
      ok: false,
      error: { field: "channel", message: "Select a destination channel." },
    };
  }
  return {
    ok: true,
    value: {
      policyTemplateId: "commerce_operator",
      capabilityProfile,
      cuePresetId,
      cueTarget: {
        workspaceId: workspaceId.trim(),
        channelId: channelId.trim(),
      },
    },
  };
}
